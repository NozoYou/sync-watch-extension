/* Shared, domain-scoped adapters for public streaming episode catalogs and media. */
(() => {
    const identityPattern = /^web:([a-z0-9.-]+):([0-9]{1,20}):([1-9][0-9]{0,3}):([1-9][0-9]{0,5})$/;
    const seriesPattern = /^web:([a-z0-9.-]+):([0-9]{1,20}):([1-9][0-9]{0,3})$/;

    function providerFor(host) {
        if (/^(?:www\.)?(?:agedm\.[a-z.]+|agefans\.[a-z.]+|age\.tv|agespa-[a-z0-9-]+\.[a-z.]+)$/.test(host)) return 'age';
        if (/^(?:www\.)?(?:omofun|omofunn)\.[a-z.]+$/.test(host)) return 'omofun';
        if (/^(?:www\.)?(?:yhdm|yinghuacd|imomoe|sakuradm|sakuraanime)\.[a-z.]+$/.test(host)) return 'sakura';
        return '';
    }

    function identify(value) {
        let url;
        try { url = new URL(value); } catch { return null; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
        const domain = url.hostname.toLowerCase();
        const provider = providerFor(domain);
        const path = provider === 'age'
            ? url.pathname.match(/^\/play\/(\d{1,20})\/([1-9]\d{0,3})\/([1-9]\d{0,5})\/?$/)
            : provider === 'omofun'
                ? url.pathname.match(/^\/vod\/play\/(\d{1,20})\/ep([1-9]\d{0,5})\.html$/)
                : provider === 'sakura'
                    ? url.pathname.match(/^\/vod-play\/(\d{1,20})\/ep([1-9]\d{0,5})\.html$/) : null;
        if (!path) return null;
        const seriesKey = path[1];
        const line = provider === 'age' ? path[2] : '1';
        const episode = provider === 'age' ? path[3] : path[2];
        return {
            domain, sourceDomain: domain, provider, seriesKey, line, episode,
            seriesId: `web:${domain}:${seriesKey}:${line}`,
            episodeId: `web:${domain}:${seriesKey}:${line}:${episode}`,
            url: `${url.origin}${url.pathname}`,
        };
    }

    function episodeUrl(id) {
        const match = String(id).match(identityPattern);
        if (!match) throw new Error('Invalid streaming episode identity.');
        const [, domain, seriesKey, line, episode] = match;
        const provider = providerFor(domain);
        let path;
        if (provider === 'age') path = `/play/${seriesKey}/${line}/${episode}`;
        else if (line === '1' && provider === 'omofun') path = `/vod/play/${seriesKey}/ep${episode}.html`;
        else if (line === '1' && provider === 'sakura') path = `/vod-play/${seriesKey}/ep${episode}.html`;
        else throw new Error('Unsupported streaming episode identity.');
        return `https://${domain}${path}`;
    }

    function validEpisodeId(id) {
        try { return identify(episodeUrl(id))?.episodeId === id; } catch { return false; }
    }

    function validSeriesId(id) {
        return seriesPattern.test(String(id)) && validEpisodeId(`${id}:1`);
    }

    function text(value) {
        return String(value).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
            const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
            if (names[entity.toLowerCase()]) return names[entity.toLowerCase()];
            const code = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
            return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        });
    }

    function attribute(tag, name) {
        const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
        return match ? text(match[1] ?? match[2] ?? match[3]) : '';
    }

    async function read(url, readPage) {
        const response = await readPage(url);
        const html = typeof response === 'string' ? response : response?.html;
        const finalUrl = typeof response === 'string' ? url : (response?.url || url);
        if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) throw new Error('Playback page unavailable or too large.');
        return { html, url: finalUrl };
    }

    async function catalog(pageUrl, readPage) {
        const identity = identify(pageUrl);
        if (!identity) throw new Error('Unsupported streaming playback URL.');
        const { html, url } = await read(identity.url, readPage);
        if (identify(url)?.episodeId !== identity.episodeId) throw new Error('Playback page redirected to another identity.');
        const episodes = new Map();
        for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
            const href = attribute(match[0], 'href');
            let candidate;
            try { candidate = identify(new URL(href, url).href); } catch { continue; }
            if (!candidate || candidate.seriesId !== identity.seriesId) continue;
            episodes.set(candidate.episodeId, { id: candidate.episodeId, number: candidate.episode, url: candidate.url });
        }
        if (!episodes.has(identity.episodeId)) throw new Error('Current episode is missing from the public series catalog.');
        const items = [...episodes.values()].sort((a, b) => Number(a.number) - Number(b.number));
        if (items.length < 3) throw new Error('At least three published episodes are required for OP/ED detection.');
        const titleTag = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const title = text((titleTag?.[1] || identity.seriesKey).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 300);
        return { currentId: identity.episodeId, seriesId: identity.seriesId, sourceDomain: identity.domain,
            title, episodeOrder: items.map(item => item.id), episodes: items };
    }

    function unescapeLiteral(value) {
        return text(value.replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|([\\/'"]))/gi,
            (_, unicode, hex, slash) => unicode || hex ? String.fromCharCode(parseInt(unicode || hex, 16)) : slash));
    }

    function media(value, base) {
        if (typeof value !== 'string') return null;
        let url;
        try { url = new URL(unescapeLiteral(value), base); } catch { return null; }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
        if (/(?:^|[/_.-])(?:adposter|advert|preroll|ads?)(?:[/_.-]|$)/i.test(url.pathname)) return null;
        if (/\.m3u8(?:$|[?#])/i.test(url.href)) return { audioUrl: url.href, mediaType: 'hls', referer: base };
        if (/\.(?:mp4|m4a|mp3|aac|ogg|webm)(?:$|[?#])/i.test(url.href)) return { audioUrl: url.href, mediaType: 'mp4', referer: base };
        return null;
    }

    function directMedia(html, base) {
        for (const tag of html.matchAll(/<(?:video|source)\b[^>]*>/gi)) {
            const result = media(attribute(tag[0], 'src'), base);
            if (result) return result;
        }
        // Accept literal player media properties; never execute page JavaScript.
        for (const item of html.matchAll(/(?:["']?(?:url|file|video_url|videoUrl|Vurl)["']?)\s*[:=]\s*(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
            const result = media(item[2], base);
            if (result) return result;
        }
        return null;
    }

    async function resolve(pageUrl, readPage, options = {}) {
        const identity = identify(pageUrl);
        if (!identity) throw new Error('Unsupported streaming playback URL.');
        const page = await read(identity.url, readPage);
        if (identify(page.url)?.episodeId !== identity.episodeId) throw new Error('Playback page redirected to another identity.');
        if (identity.provider === 'omofun' || identity.provider === 'sakura') {
            const prefix = identity.provider === 'omofun' ? '/_dyn_plays/' : '/_get_plays/';
            const apiUrl = new URL(`${prefix}${identity.seriesKey}/ep${identity.episode}`, page.url).href;
            const body = await read(apiUrl, readPage);
            let payload;
            try { payload = JSON.parse(body.html); } catch { throw new Error('Streaming media API returned invalid JSON.'); }
            const source = payload.video_plays?.[0];
            const result = media(source?.play_data, page.url);
            if (result) return { ...result, sourceDomain: identity.domain, sourceSite: String(source.src_site || '').slice(0, 60) };
            throw new Error('The default playback source has no supported public media URL.');
        }
        const visited = new Set();
        async function scan(current, depth) {
            if (depth > 3 || visited.has(current.url)) return null;
            visited.add(current.url);
            const direct = directMedia(current.html, current.url);
            if (direct) return direct;
            const frames = [...current.html.matchAll(/<iframe\b[^>]*>/gi)].slice(0, 4);
            for (const frame of frames) {
                const src = attribute(frame[0], 'src');
                if (!src) continue;
                let url;
                try { url = new URL(src, current.url); } catch { continue; }
                if (!['https:', 'http:'].includes(url.protocol)) continue;
                // The reader owns DNS, redirect and cross-origin access checks.
                const result = await scan(await read(url.href, readPage), depth + 1);
                if (result) return result;
            }
            return null;
        }
        const result = await scan(page, 0);
        if (result) return { ...result, sourceDomain: identity.domain };
        if (options.currentMediaUrl) {
            const current = media(options.currentMediaUrl, page.url);
            if (current) return { ...current, sourceDomain: identity.domain };
        }
        throw new Error('The playback source is encrypted or requires a running player; no public media URL was found.');
    }

    async function discover(pageUrl, readPage, options = {}) {
        const listing = await catalog(pageUrl, readPage);
        if (options.catalogOnly) return listing;
        let selected;
        if (options.episodeIds) {
            if (!Array.isArray(options.episodeIds) || options.episodeIds.length !== 3 || new Set(options.episodeIds).size !== 3) throw new Error('Three distinct episode IDs are required.');
            selected = options.episodeIds.map(id => listing.episodes.find(item => item.id === id));
            if (selected.some(item => !item)) throw new Error('Episode outside current series or playback line.');
        } else {
            const current = listing.episodeOrder.indexOf(listing.currentId);
            const start = Math.min(Math.max(0, current - 1), listing.episodes.length - 3);
            selected = listing.episodes.slice(start, start + 3);
        }
        const resolved = [];
        for (const episode of selected) resolved.push({ ...episode, ...(await resolve(episode.url, readPage,
            episode.id === listing.currentId ? options : {})) });
        return { currentId: listing.currentId, catalog: listing,
            metadata: { seriesId: listing.seriesId, title: listing.title, sourceDomain: listing.sourceDomain, episodes: selected },
            episodes: resolved };
    }

    const api = { identify, episodeUrl, validEpisodeId, validSeriesId, providerFor, catalog, resolve, discover };
    globalThis.SyncWatchStreamingSites = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
