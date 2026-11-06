// Fetch each supported site's media independently and verify candidate boundaries on the server.
const sites = require('../shared/streaming-sites');
const mediaLoader = require('../shared/media-loader');
const { fetchBytes, readPage } = require('./safe-fetch');
const { decodeAudio } = require('./decode-audio');
const { viewingUrl, sourceDomain } = require('./identities');
const { promoteVerified, lookupRecords } = require('./record-store');
require('../extension/audio-core.js');

const headers = { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' };
let pending = Promise.resolve();
let queuedCount = 0;
const recentTasks = new Map();

async function bilibili(path) {
    const response = await fetch(`https://api.bilibili.com${path}`, {
        headers, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Bilibili API HTTP ${response.status}`);
    const body = await response.json();
    if (body.code !== 0) throw new Error(`Bilibili API code ${body.code}`);
    return body.result || body.data;
}

async function audioUrl(id) {
    let play;
    if (/^\d{1,20}$/.test(id)) {
        const season = await bilibili(`/pgc/view/web/season?ep_id=${id}`);
        const episode = (season.episodes || []).find(item => String(item.id) === id);
        if (!episode?.cid) throw new Error('Episode CID unavailable.');
        play = await bilibili(`/pgc/player/web/playurl?ep_id=${id}&cid=${episode.cid}&qn=16&fnval=4048&fourk=0`);
    } else {
        const match = id.match(/^ugc:(BV[0-9A-Za-z]{10}):p([1-9]\d{0,3})$/);
        if (!match) throw new Error('Invalid video ID.');
        const view = await bilibili(`/x/web-interface/view?bvid=${match[1]}`);
        const page = (view.pages || []).find(item => Number(item.page) === Number(match[2]));
        if (!page?.cid) throw new Error('Video CID unavailable.');
        play = await bilibili(`/x/player/playurl?bvid=${match[1]}&cid=${page.cid}&qn=16&fnval=4048&fourk=0`);
    }
    const audio = (play.dash?.audio || []).filter(item =>
        (item.mimeType || item.mime_type || '').startsWith('audio/') &&
        Number(item.bandwidth) > 0 && (item.baseUrl || item.base_url))
        .sort((a, b) => a.bandwidth - b.bandwidth)[0];
    if (!audio) throw new Error('Independent audio track unavailable.');
    const url = new URL(audio.baseUrl || audio.base_url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.bilivideo.com')) {
        throw new Error('Unexpected audio host.');
    }
    return { url: url.href, bandwidth: Number(audio.bandwidth) };
}

async function extract(id) {
    console.info('OP/ED verification resolving audio', { episodeId: id });
    const streaming = id.startsWith('web:');
    const source = streaming ? await sites.resolve(viewingUrl(id), readPage) : await audioUrl(id);
    const url = streaming ? source.audioUrl : source.url;
    const configuredLimit = Number(process.env.OPED_MAX_MEDIA_BYTES || 512 * 1024 * 1024);
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 16 * 1024 * 1024 || configuredLimit > 2 * 1024 * 1024 * 1024) {
        throw new Error('OPED_MAX_MEDIA_BYTES must be between 16 MiB and 2 GiB.');
    }
    const maxBytes = streaming ? configuredLimit : 64 * 1024 * 1024;
    const control = AbortSignal.timeout(15 * 60000);
    let size = 0;
    console.info('OP/ED verification downloading media', {
        episodeId: id, sourceDomain: sourceDomain(id), mediaType: source.mediaType || 'audio',
        bitrateKbps: source.bandwidth ? Math.round(source.bandwidth / 1000) : null,
    });
    const media = await mediaLoader.load(url, {
        signal: control, maxBytes, ...(streaming ? { windowSeconds: 302 } : {}), crypto: require('node:crypto').webcrypto,
        fetchBytes: async (target, options = {}) => {
            const bytes = await fetchBytes(target, { signal: options.signal || control,
                maxBytes: Math.max(0, maxBytes - size), referer: source.referer || 'https://www.bilibili.com/' });
            size += bytes.length;
            if (size > maxBytes) throw new Error('Episode media exceeds download limit.');
            return bytes;
        },
    });
    console.info('OP/ED verification media downloaded', { episodeId: id, bytes: size });
    console.info('OP/ED verification decoding audio', { episodeId: id });
    let samples;
    if (media.windows) {
        if (!Number.isFinite(media.duration) || media.duration <= 0 || media.duration > 3600) throw new Error('Unsupported media duration.');
        samples = new Float32Array(Math.round(media.duration * 8000));
        for (const window of media.windows) {
            const decoded = await decodeAudio(window.bytes);
            const offset = Math.round(window.start * 8000);
            if (offset < 0 || offset >= samples.length) throw new Error('Invalid audio window offset.');
            samples.set(decoded.subarray(0, samples.length - offset), offset);
        }
        console.info('OP/ED verification decoded matching windows', { episodeId: id, durationSeconds: media.duration, windows: media.windows.map(item => ({start:item.start, bytes:item.bytes.length})) });
    } else {
        samples = await decodeAudio(media);
    }
    const features = globalThis.SyncWatchOpedAudio.extract(samples);
    console.info('OP/ED verification audio decoded', {
        episodeId: id, durationSeconds: Math.round(samples.length / 8000),
        fingerprintFrames: features.features.length,
    });
    return { id, ...features, downloadedBytes: size };
}

function matches(verified, candidate) {
    if (!verified) return false;
    return ['opening', 'ending'].every(type => {
        const left = verified.segments.find(item => item.type === type);
        const right = candidate[type];
        return (!left && !right) || (left && right &&
            Math.abs(left.start - right.start) <= 3 && Math.abs(left.end - right.end) <= 3);
    });
}

async function catalog(metadata, seed) {
    let episodes;
    if (metadata.seriesId.startsWith('web:')) {
        const result = await sites.catalog(viewingUrl(seed), readPage);
        if (result.seriesId !== metadata.seriesId) throw new Error('Catalog identity mismatch.');
        episodes = result.episodes;
    } else if (/^\d+$/.test(metadata.seriesId)) {
        const season = await bilibili(`/pgc/view/web/season?season_id=${metadata.seriesId}`);
        episodes = (season.episodes || []).filter(item => item.cid && /^\d+(?:\.\d+)?$/.test(String(item.title)))
            .map(item => ({ id: String(item.id), number: String(item.title) }));
    } else {
        const bvid = seed.match(/^ugc:(BV[0-9A-Za-z]{10}):p/)?.[1];
        if (!bvid) throw new Error('Missing catalog video ID.');
        const view = await bilibili(`/x/web-interface/view?bvid=${bvid}`);
        if (metadata.seriesId.startsWith('ugc:multi:')) {
            if (metadata.seriesId !== `ugc:multi:${bvid}`) throw new Error('Catalog identity mismatch.');
            episodes = (view.pages || []).map(item => ({ id: `ugc:${bvid}:p${item.page}`, number: String(item.page) }));
        } else {
            if (metadata.seriesId !== `ugc:season:${view.ugc_season?.id}`) throw new Error('Catalog identity mismatch.');
            episodes = (view.ugc_season.sections || []).flatMap(item => item.episodes || [])
                .map((item, index) => ({ id: `ugc:${item.bvid || item.arc?.bvid}:p1`, number: String(index + 1) }));
        }
    }
    episodes = episodes.filter((item, index) => episodes.findIndex(other => other.id === item.id) === index);
    if (episodes.length < 3 || episodes.length > 1000 || !episodes.some(item => item.id === seed)) {
        throw new Error('Full catalog unavailable or unsupported catalog size.');
    }
    return episodes;
}

// Merge reports arriving during a series job without scheduling another download.
const seriesJobs = new Map();
function queueVerification(metadata, candidates, eligible) {
    const key = metadata.seriesId;
    let job = seriesJobs.get(key);
    if (job) {
        for (const item of candidates) if (eligible.includes(item.id)) job.candidates.set(item.id, item);
        console.info('OP/ED verification joined series task', { seriesId: key });
        return;
    }
    if (queuedCount >= 3 || Date.now() - (recentTasks.get(key) || 0) < 6 * 3600000) {
        console.info('OP/ED verification deferred', { seriesId: key, reason: queuedCount >= 3 ? 'queue_full' : 'recent_series_task' });
        return;
    }
    job = { candidates: new Map(candidates.filter(item => eligible.includes(item.id)).map(item => [item.id, item])) };
    seriesJobs.set(key, job);
    queuedCount += 1;
    console.info('OP/ED full-series verification queued', { seriesId: key });
    const task = async () => {
        const episodes = await catalog(metadata, candidates[0].id);
        if (candidates.some(item => !episodes.some(entry => entry.id === item.id))) throw new Error('Reported episode outside catalog.');
        console.info('OP/ED full-series catalog loaded', { seriesId: key, total: episodes.length });
        const features = new Map();
        const results = new Map();
        let downloadedBytes = 0;
        // Keep only the current three-episode window; each audio track is downloaded once.
        for (let index = 0; index < episodes.length; index += 1) {
            const start = Math.min(Math.max(0, index - 1), episodes.length - 3);
            const window = episodes.slice(start, start + 3);
            for (const episode of window) {
                if (features.has(episode.id)) continue;
                try {
                    const data = await extract(episode.id);
                    downloadedBytes += data.downloadedBytes;
                    features.set(episode.id, data);
                } catch (error) {
                    features.set(episode.id, null);
                    console.error('OP/ED verification episode unavailable', { episodeId: episode.id, error: error.message });
                }
            }
            const audio = window.map(item => features.get(item.id));
            if (audio.every(Boolean)) {
                const detected = globalThis.SyncWatchOpedAudio.detect(audio).episodes.find(item => item.id === episodes[index].id);
                if (detected) results.set(detected.id, detected);
            }
            console.info('OP/ED full-series progress', { seriesId: key, completed: index + 1, total: episodes.length, downloadedBytes });
            const nextStart = Math.min(Math.max(0, index), episodes.length - 3);
            for (const id of features.keys()) if (!episodes.slice(nextStart, nextStart + 3).some(item => item.id === id)) features.delete(id);
        }
        const existing = await lookupRecords(episodes.map(item => item.id));
        const confirmed = [];
        let agreed = false;
        for (const [id, candidate] of job.candidates) {
            const verified = results.get(id);
            const matched = matches(verified, candidate);
            console.info('OP/ED verification compared episode', { episodeId: id, matched, candidate: { opening: candidate.opening, ending: candidate.ending }, independentlyDetected: verified?.segments || [] });
            if (matched) { confirmed.push(candidate); agreed = true; }
        }
        // New unreported episodes can use the independent results after a submitted result agrees.
        if (agreed) for (const episode of episodes) {
            const verified = results.get(episode.id);
            if (!verified || existing[episode.id] || job.candidates.has(episode.id)) continue;
            const times = Object.fromEntries(['opening', 'ending'].map(type => {
                const segment = verified.segments.find(item => item.type === type);
                return [type, segment ? { start: segment.start, end: segment.end } : null];
            }));
            confirmed.push({ ...episode, duration: verified.duration,
                sourceDomain: sourceDomain(episode.id), url: viewingUrl(episode.id),
                updatedAt: new Date().toISOString(), ...times });
        }
        if (confirmed.length) await promoteVerified(metadata, confirmed);
        recentTasks.set(key, Date.now());
        if (recentTasks.size > 500) recentTasks.delete(recentTasks.keys().next().value);
        console.info('OP/ED full-series verification finished', { seriesId: key, total: episodes.length, analyzed: results.size, saved: confirmed.length, downloadedBytes });
    };
    pending = pending.then(task, task)
        .catch(error => console.error('OP/ED independent verification failed', { seriesId: key, error: error.message }))
        .finally(() => { queuedCount -= 1; seriesJobs.delete(key); });
}

module.exports = { queueVerification };
