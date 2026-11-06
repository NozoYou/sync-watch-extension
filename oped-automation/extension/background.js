/* OP/ED tasks own their storage and never change the room/player configuration. */
importScripts(
    'oped-automation/extension/local-record-store.js',
    'oped-automation/extension/season-queue.js',
    'oped-automation/shared/streaming-sites.js',
);
(() => {
    const defaults = { enabled: false, mode: 'local', server: '', token: '' };
    let preparing = false;
    let creation = null;
    const queuedSeasons = new Set();
    const BACKGROUND_BATCH_DELAY_MS = 15_000;
    let nextBatchTimer = null;

    function hasFreshResult(result) {
        // An empty segment list is also a completed detection, not a cache miss.
        return Boolean(result && Date.now() - result.savedAt < 7 * 86400000);
    }

    // Keep progress in the service worker console so every stage is visible in one place.
    function log(step, details = {}) {
        console.info('[一起看 OP/ED]', step, details);
    }

    async function status(message) {
        await chrome.storage.local.set({ opedStatus: message });
    }

    async function ensureDocument() {
        if (creation) return creation;
        creation = (async () => {
            if (await chrome.offscreen.hasDocument()) return;
            await chrome.offscreen.createDocument({
                url: 'oped-automation/extension/offscreen.html',
                reasons: ['WORKERS', 'BLOBS'],
                justification: 'Decode audio and compare episode fingerprints without interrupting playback.',
            });
        })();
        try { await creation; } finally { creation = null; }
    }

    // Executed in the Bilibili page so authenticated API requests use its session.
    async function discoverEpisodes(expectedUrl, options = {}) {
        const requestedPage = new URL(expectedUrl);
        const requestedPart = requestedPage.searchParams.get('p') || '1';
        const isCurrentPage = () => location.origin === requestedPage.origin &&
            location.pathname === requestedPage.pathname &&
            (location.pathname.startsWith('/bangumi/') ||
                (new URL(location.href).searchParams.get('p') || '1') === requestedPart);
        if (!isCurrentPage()) return { stale: true };
        async function api(path) {
            const response = await fetch(`https://api.bilibili.com${path}`, {
                credentials: 'include', signal: AbortSignal.timeout(25000),
            });
            const body = await response.json();
            if (body.code !== 0) throw new Error(`B站接口返回 ${body.code}，无法获取可访问的音轨。`);
            return body.result || body.data;
        }
        const videoMatch = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
        if (videoMatch) {
            const bvid = videoMatch[1];
            function readPodCatalog() {
                for (const pod of document.querySelectorAll('.video-pod')) {
                    const header = pod.querySelector('.video-pod__header a[href*="collectiondetail"]');
                    if (!header) continue;
                    const link = new URL(header.getAttribute('href'), location.href);
                    const sid = link.searchParams.get('sid');
                    if (link.hostname !== 'space.bilibili.com' || !/^\d{1,20}$/.test(sid || '')) continue;
                    const seen = new Set();
                    const episodes = [];
                    for (const row of pod.querySelectorAll('.video-pod__list .video-pod__item[data-key]')) {
                        const key = row.getAttribute('data-key');
                        if (!/^BV[0-9A-Za-z]{10}$/.test(key || '') || seen.has(key)) continue;
                        seen.add(key);
                        episodes.push({ bvid: key });
                    }
                    // A related-video list or a stale pod must not become the current catalog.
                    if (episodes.length >= 3 && seen.has(bvid)) {
                        return {
                            id: sid,
                            title: header.getAttribute('title') || header.textContent.trim(),
                            sections: [{ episodes }],
                        };
                    }
                }
                return null;
            }
            const podSeason = readPodCatalog();
            let view;
            try {
                view = await api(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
            } catch (error) {
                const initialView = window.__INITIAL_STATE__?.videoData;
                if (initialView?.bvid === bvid) view = initialView;
                else if (podSeason) view = { title: podSeason.title };
                else throw error;
            }
            const pages = (view.pages || []).filter(item => item.cid && Number(item.page) > 0);
            const part = Number(requestedPart);
            const apiSeason = view.ugc_season;
            const apiBvids = new Set((apiSeason?.sections || [])
                .flatMap(section => section.episodes || []).map(item => item.bvid || item.arc?.bvid));
            const season = apiSeason?.id && apiBvids.has(bvid) && apiBvids.size >= 3
                ? apiSeason
                : podSeason && (!apiSeason?.id || String(apiSeason.id) === podSeason.id)
                    ? podSeason : apiSeason;
            const seasonItems = (season?.sections || []).flatMap(section => section.episodes || [])
                .map((item, index) => {
                    const itemBvid = item.bvid || item.arc?.bvid;
                    if (!/^BV[0-9A-Za-z]{10}$/.test(itemBvid || '')) return null;
                    return {
                        id: `ugc:${itemBvid}:p1`, bvid: itemBvid,
                        cid: item.cid || item.arc?.cid, page: 1,
                        number: String(index + 1),
                        url: `https://www.bilibili.com/video/${itemBvid}/`,
                    };
                }).filter(Boolean);
            let items;
            let seriesId;
            let title;
            if (part === 1 && seasonItems.length >= 3 &&
                seasonItems.some(item => item.bvid === bvid) && season?.id) {
                seriesId = `ugc:season:${season.id}`;
                title = season.title || view.title;
                items = seasonItems.filter((item, index) =>
                    seasonItems.findIndex(other => other.id === item.id) === index);
            } else if (pages.length >= 3) {
                seriesId = `ugc:multi:${bvid}`;
                title = view.title;
                items = pages.map(item => ({
                    id: `ugc:${bvid}:p${item.page}`, bvid, cid: item.cid,
                    page: item.page, number: String(item.page),
                    url: `https://www.bilibili.com/video/${bvid}/?p=${item.page}`,
                }));
            } else {
                items = [];
            }
            const currentId = `ugc:${bvid}:p${Number.isInteger(part) && part > 0 ? part : 1}`;
            if (!seriesId || items.length < 3 || !items.some(item => item.id === currentId)) {
                throw new Error('当前视频没有可供比对的三集连续合集或多 P 内容。');
            }
            const catalog = {
                seriesId, title, episodeOrder: items.map(item => item.id),
                episodes: items.map(({ id, number, url }) => ({ id, number, url })),
            };
            if (options.catalogOnly) {
                if (!isCurrentPage()) return { stale: true };
                return { currentId, ...catalog };
            }
            const currentIndex = items.findIndex(item => item.id === currentId);
            const selected = options.episodeIds
                ? options.episodeIds.map(id => items.find(item => item.id === id))
                : [items[currentIndex], ...items.filter(item => item.id !== currentId)
                    .sort((a, b) => Math.abs(items.indexOf(a) - currentIndex) -
                        Math.abs(items.indexOf(b) - currentIndex)).slice(0, 2)];
            if (selected.length !== 3 || selected.some(item => !item)) {
                throw new Error('无法找到后台队列中的三集视频。');
            }
            const result = [];
            for (const item of selected) {
                let cid = item.cid;
                if (!cid) {
                    const details = await api(`/x/web-interface/view?bvid=${encodeURIComponent(item.bvid)}`);
                    cid = details.pages?.[0]?.cid || details.cid;
                }
                if (!cid) throw new Error(`第 ${item.number} 集没有可读取的视频标识。`);
                const play = await api(`/x/player/playurl?bvid=${encodeURIComponent(item.bvid)}&cid=${cid}&qn=16&fnval=4048&fourk=0`);
                const audio = (play.dash?.audio || []).filter(track =>
                    (track.mimeType || track.mime_type || '').startsWith('audio/') &&
                    Number(track.bandwidth) > 0 && (track.baseUrl || track.base_url))
                    .sort((a, b) => a.bandwidth - b.bandwidth)[0];
                if (!audio) throw new Error(`第 ${item.number} 集没有可访问的独立音轨。`);
                result.push({
                    id: item.id, cid: String(cid), number: item.number,
                    audioUrl: audio.baseUrl || audio.base_url, bandwidth: audio.bandwidth,
                });
            }
            if (!isCurrentPage()) return { stale: true };
            return {
                currentId, episodes: result, catalog,
                metadata: {
                    seriesId, title,
                    episodes: selected.map(({ id, number, url }) => ({ id, number, url })),
                },
            };
        }
        const match = location.pathname.match(/^\/bangumi\/play\/(ep|ss)(\d+)/);
        if (!match) throw new Error('目前仅支持 B 站番剧和连续合集页面。');
        const season = await api(`/pgc/view/web/season?${match[1] === 'ep' ? 'ep_id' : 'season_id'}=${match[2]}`);
        const currentId = match[1] === 'ep'
            ? Number(match[2])
            : Number(window.__INITIAL_STATE__?.epInfo?.id);
        const episodes = (season.episodes || []).filter(item =>
            item.id && item.cid && /^\d+(?:\.\d+)?$/.test(String(item.title)));
        const catalog = {
            seriesId: String(season.season_id),
            title: season.title,
            episodeOrder: episodes.map(item => String(item.id)),
            episodes: episodes.map(item => ({ id: String(item.id), number: item.title })),
        };
        if (options.catalogOnly) {
            if (!isCurrentPage()) return { stale: true };
            return { currentId: String(currentId), ...catalog };
        }
        const current = episodes.find(item => item.id === currentId);
        if (!current || episodes.length < 3) throw new Error('未找到当前集及另外两集连续正片。');
        const references = episodes.filter(item => item.id !== currentId)
            .sort((a, b) => Math.abs(Number(a.title) - Number(current.title)) -
                Math.abs(Number(b.title) - Number(current.title))).slice(0, 2);
        const selected = options.episodeIds
            ? options.episodeIds.map(id => episodes.find(item => String(item.id) === id))
            : [current, ...references];
        if (selected.length !== 3 || selected.some(item => !item)) {
            throw new Error('无法找到后台队列中的三集正片。');
        }
        const result = [];
        for (const item of selected) {
            const play = await api(`/pgc/player/web/playurl?ep_id=${item.id}&cid=${item.cid}&qn=16&fnval=4048&fourk=0`);
            const audio = (play.dash?.audio || []).filter(track =>
                (track.mimeType || track.mime_type || '').startsWith('audio/') &&
                Number(track.bandwidth) > 0 && (track.baseUrl || track.base_url))
                .sort((a, b) => a.bandwidth - b.bandwidth)[0];
            if (!audio) throw new Error(`第 ${item.title} 集没有可访问的独立音轨。`);
            result.push({
                id: String(item.id), cid: String(item.cid), number: item.title,
                audioUrl: audio.baseUrl || audio.base_url, bandwidth: audio.bandwidth,
            });
        }
        if (!isCurrentPage()) return { stale: true };
        return {
            currentId: String(currentId), episodes: result, catalog,
            metadata: {
                seriesId: String(season.season_id), title: season.title,
                episodes: result.map(item => ({ id: item.id, number: item.number })),
            },
        };
    }

    async function resolveEpisodes(tabId, pageUrl, options = {}) {
        if (SyncWatchStreamingSites.identify(pageUrl)) {
            const readPage = async target => {
                const url = new URL(target);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
                    /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|.*\.local$)/i.test(url.hostname)) {
                    throw new Error('Unsupported streaming source URL.');
                }
                const response = await fetch(url.href, { credentials: 'omit', signal: AbortSignal.timeout(25000) });
                if (!response.ok) throw new Error(`Source page HTTP ${response.status}`);
                const reader = response.body.getReader();
                const parts = [];
                let size = 0;
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Source page is too large.'); }
                    parts.push(value);
                }
                return { html: await new Blob(parts).text(), url: response.url };
            };
            return SyncWatchStreamingSites.discover(pageUrl, readPage, options);
        }
        const [execution] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] }, world: 'MAIN', func: discoverEpisodes,
            args: [pageUrl, options],
        });
        return execution?.result;
    }

    function episodeId(url) {
        try {
            const parsed = new URL(url);
            const streaming = SyncWatchStreamingSites.identify(url);
            if (streaming) return streaming.episodeId;
            if (parsed.hostname !== 'www.bilibili.com') return '';
            const video = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
            if (video) {
                const part = Number(parsed.searchParams.get('p') || 1);
                return `ugc:${video[1]}:p${Number.isInteger(part) && part > 0 ? part : 1}`;
            }
            return parsed.pathname.match(/^\/bangumi\/play\/ep(\d+)/)?.[1] || '';
        } catch { return ''; }
    }

    async function cachedEpisode(id, results) {
        if (hasFreshResult(results?.[id])) return results[id];
        if (!id) return null;
        try {
            const record = await SyncWatchOpedRecords.getEpisode(id);
            if (record) log('从电脑本地记录文件读取结果', { episodeId: id });
            return record;
        } catch (error) {
            log('本地记录文件读取失败', { message: error.message });
            return null;
        }
    }

    async function cloudRecords(ids, settings) {
        if (!ids.length || !settings.server) return {};
        try {
            const server = new URL(settings.server);
            if (server.protocol !== 'https:' &&
                !(server.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(server.hostname))) return {};
            const query = new URLSearchParams();
            for (const id of ids.slice(0, 100)) query.append('id', id);
            const response = await fetch(`${server.href.replace(/\/$/, '')}/records/lookup?${query}`, {
                signal: AbortSignal.timeout(6000), cache: 'no-store',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const records = (await response.json()).records || {};
            const valid = {};
            for (const id of ids) {
                const record = records[id];
                if (!record || !Number.isFinite(record.duration) || record.duration <= 0 ||
                    !Array.isArray(record.segments) || record.segments.length > 2 ||
                    !record.segments.every(segment =>
                        ['opening', 'ending'].includes(segment.type) &&
                        Number.isFinite(segment.start) && Number.isFinite(segment.end) &&
                        segment.start >= 0 && segment.end > segment.start &&
                        segment.end <= record.duration)) continue;
                valid[id] = { ...record, savedAt: Date.now() };
            }
            return valid;
        } catch (error) {
            log('云端记录查询失败，继续本地识别', { message: error.message });
            return {};
        }
    }

    async function rememberCloudRecords(records) {
        if (!Object.keys(records).length) return;
        const saved = await chrome.storage.local.get('opedResults');
        const results = { ...saved.opedResults, ...records };
        const entries = Object.entries(results)
            .sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 100);
        await chrome.storage.local.set({ opedResults: Object.fromEntries(entries) });
        log('已读取云端识别结果', { count: Object.keys(records).length });
    }

    function queueSeason(sender, pageUrl) {
        const key = `${sender.tab.id}:${episodeId(pageUrl) || new URL(pageUrl).pathname}`;
        if (queuedSeasons.has(key)) return;
        queuedSeasons.add(key);

        setTimeout(() => {
            prepareSeason(sender, pageUrl)
                .catch(error => log('整季检测队列准备失败', { message: error.message }))
                .finally(() => queuedSeasons.delete(key));
        }, 1000);
    }

    async function prepareSeason(sender, pageUrl) {
        const saved = await chrome.storage.local.get('opedSettings');
        if (!saved.opedSettings?.enabled) return;
        const catalog = await resolveEpisodes(sender.tab.id, pageUrl, { catalogOnly: true });
        if (!catalog || catalog.stale) return;
        // Migrate pre-existing browser cache entries without redownloading audio.
        try {
            const known = new Set(await SyncWatchOpedRecords.knownEpisodes(catalog.seriesId));
            const cached = await chrome.storage.local.get('opedResults');
            const episodes = catalog.episodeOrder
                .filter(id => !known.has(id) && cached.opedResults?.[id])
                .map(id => ({ id, ...cached.opedResults[id] }));
            if (episodes.length) await SyncWatchOpedRecords.save(catalog, { episodes }, true);
        } catch (error) {
            log('已有缓存写入本地文件失败', { message: error.message });
        }
        await saveSeasonQueue(catalog, sender.tab.id);
        scheduleNextBatch();
    }

    async function saveSeasonQueue(catalog, tabId) {
        await chrome.storage.session.set({ opedSeasonQueue: { ...catalog, tabId } });
    }

    function scheduleNextBatch() {
        if (nextBatchTimer !== null) return;
        // Serial batches and a deliberate gap keep background work bounded.
        nextBatchTimer = setTimeout(() => {
            nextBatchTimer = null;
            advanceSeasonQueue().catch(error => log('后台检测队列已暂停', { message: error.message }));
        }, BACKGROUND_BATCH_DELAY_MS);
    }

    async function advanceSeasonQueue() {
        const saved = await chrome.storage.local.get(['opedSettings', 'opedResults']);
        if (!saved.opedSettings?.enabled || preparing) return;
        const session = await chrome.storage.session.get([
            'opedSeasonQueue', 'opedActiveJob', 'opedFailedEpisodes', 'opedForceQueue',
        ]);
        const queue = session.opedSeasonQueue;
        if (!queue || session.opedActiveJob) return;
        const forceQueue = session.opedForceQueue?.seriesId === queue.seriesId ? session.opedForceQueue : null;
        const cloud = forceQueue ? {} : await cloudRecords(queue.episodeOrder, saved.opedSettings);
        if (!forceQueue) await rememberCloudRecords(cloud);
        const known = new Set(Object.entries(saved.opedResults || {})
            .filter(([, value]) => hasFreshResult(value)).map(([id]) => id));
        for (const id of Object.keys(cloud)) known.add(id);
        try {
            for (const id of await SyncWatchOpedRecords.knownEpisodes(queue.seriesId)) known.add(id);
        } catch (error) {
            log('本地记录文件读取失败，使用浏览器缓存继续', { message: error.message });
        }
        const failed = session.opedFailedEpisodes || [];
        const episodeIds = SyncWatchOpedQueue.nextBatch(queue.episodeOrder,
            forceQueue ? forceQueue.completed : [...known], failed);
        if (!episodeIds.length) {
            if (forceQueue) await chrome.storage.session.remove('opedForceQueue');
            await status('当前系列的可检测视频已处理完成；结果已缓存。');
            log('整季检测队列已完成', { series: queue.title, completed: known.size, failed: failed.length });
            return;
        }
        // Reuse the open authenticated page; never open or navigate a viewing tab.
        const tab = await chrome.tabs.get(queue.tabId);
        const currentId = episodeId(tab.url);
        const seasonPage = new URL(tab.url || 'https://invalid.local');
        const sameSeason = seasonPage.hostname === 'www.bilibili.com' &&
            seasonPage.pathname === `/bangumi/play/ss${queue.seriesId}`;
        if (!queue.episodeOrder.includes(currentId) && !sameSeason) return;
        log('开始后台下一批检测', { series: queue.title, episodeIds });
        await start({ tab }, tab.url, episodeIds);
    }

    async function start(sender, pageUrl, backgroundEpisodeIds = null, force = false) {
        const url = new URL(pageUrl || 'https://invalid.local');
        const id = episodeId(url.href);
        const reply = (result) => ({ pageUrl: url.href, episodeId: id, ...result });
        const saved = await chrome.storage.local.get(['opedSettings', 'opedResults']);
        const settings = { ...defaults, ...saved.opedSettings };
        log('收到识别请求', { mode: settings.mode, enabled: settings.enabled, episodeId: id });
        if (!settings.enabled) return reply({ enabled: false });
        if (!sender.tab || !(SyncWatchStreamingSites.identify(url.href) ||
            (url.hostname === 'www.bilibili.com' && (/^\/bangumi\/play\/(ep|ss)\d+/.test(url.pathname) ||
                /^\/video\/BV[0-9A-Za-z]{10}(?:\/|$)/.test(url.pathname))))) {
            return reply({ enabled: true, unsupported: true });
        }
        // SPA navigation can leave sender.url pointing at the original episode.
        // Verify the explicitly requested route against the browser's live tab URL.
        const tab = await chrome.tabs.get(sender.tab.id);
        const liveUrl = new URL(tab.url || 'https://invalid.local');
        if (liveUrl.origin !== url.origin || liveUrl.pathname !== url.pathname ||
            (id && episodeId(liveUrl.href) !== id)) {
            log('剧集已切换，忽略旧页面请求', { episodeId: id });
            return reply({ enabled: true, pending: true });
        }
        const cached = backgroundEpisodeIds || force ? null : await cachedEpisode(id, saved.opedResults);
        if (cached) {
            log('使用本地缓存结果', { episodeId: id, segments: cached.segments });
            queueSeason(sender, url.href);
            return reply({ enabled: true, segments: cached.segments });
        }
        if (!backgroundEpisodeIds && !force && id) {
            const remote = (await cloudRecords([id], settings))[id];
            if (remote) {
                await rememberCloudRecords({ [id]: remote });
                queueSeason(sender, url.href);
                return reply({ enabled: true, segments: remote.segments });
            }
        }
        const { opedActiveJob, opedFailedEpisodes } = await chrome.storage.session.get(['opedActiveJob', 'opedFailedEpisodes']);
        if (!backgroundEpisodeIds && !force && id && opedFailedEpisodes?.includes(id)) {
            return reply({ enabled: true, error: '检测失败；调整配置后重新开启识别可重试。' });
        }
        if (preparing || (opedActiveJob && Date.now() - opedActiveJob.startedAt < 16 * 60000)) {
            return reply(force
                ? { enabled: true, error: '已有识别任务正在运行，请稍后重试。' }
                : { enabled: true, pending: true });
        }
        preparing = true;
        try {
            const activeForceQueue = (await chrome.storage.session.get('opedForceQueue')).opedForceQueue;
            if (settings.mode === 'cloud' && !force && !(backgroundEpisodeIds && activeForceQueue)) {
                const server = new URL(settings.server);
                if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(server.hostname))) {
                    throw new Error('云端地址需要 HTTPS，本机可使用 HTTP。');
                }
                if (!settings.token) throw new Error('请填写云端检测密钥。');
            }
            await status(backgroundEpisodeIds
                ? '正在后台提前识别后续剧集的片头片尾…'
                : '正在获取视频目录和可用音频…');
            log('开始获取视频目录和三集音频信息');
            const execution = { result: await resolveEpisodes(sender.tab.id, url.href, { episodeIds: backgroundEpisodeIds }) };
            if (execution?.result?.stale) {
                if (backgroundEpisodeIds) scheduleNextBatch();
                return reply({ enabled: true, pending: true });
            }
            if (!execution?.result?.episodes) throw new Error('无法读取视频音轨，请确认当前账号可播放这三集。');
            log('视频目录和音轨信息获取完成', {
                series: execution.result.metadata.title,
                episodes: execution.result.episodes.map(item => ({ number: item.number, bandwidth: item.bandwidth })),
            });
            await saveSeasonQueue(execution.result.catalog, sender.tab.id);
            const resolvedCache = backgroundEpisodeIds || force ? null :
                await cachedEpisode(execution.result.currentId, saved.opedResults);
            if (resolvedCache) {
                log('使用本地缓存结果', { episodeId: execution.result.currentId, segments: resolvedCache.segments });
                scheduleNextBatch();
                return reply({ enabled: true, episodeId: execution.result.currentId, segments: resolvedCache.segments });
            }
            const latest = await chrome.storage.local.get('opedSettings');
            if (!latest.opedSettings?.enabled) return reply({ enabled: false });
            if (JSON.stringify({ ...defaults, ...latest.opedSettings }) !== JSON.stringify(settings)) {
                return reply({ enabled: true, pending: true });
            }
            if (force) {
                if (!settings.server) throw new Error('重新识别上报需要配置云端地址。');
                const reportServer = new URL(settings.server);
                if (reportServer.protocol !== 'https:' &&
                    !(reportServer.protocol === 'http:' &&
                        ['localhost', '127.0.0.1'].includes(reportServer.hostname))) {
                    throw new Error('云端地址需要 HTTPS，本机可使用 HTTP。');
                }
                await chrome.storage.session.set({ opedForceQueue: {
                    seriesId: execution.result.catalog.seriesId, completed: [],
                } });
                await chrome.storage.session.remove('opedFailedEpisodes');
            }
            const forceQueue = (await chrome.storage.session.get('opedForceQueue')).opedForceQueue;
            const reportOnly = force || forceQueue?.seriesId === execution.result.catalog.seriesId;
            // Only extension-origin CDN requests receive the site's required referer.
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [120001],
                addRules: [{
                    id: 120001, priority: 1,
                    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: `${url.origin}/` }] },
                    condition: { initiatorDomains: [chrome.runtime.id], ...(SyncWatchStreamingSites.identify(url.href) ? {} : { requestDomains: ['bilivideo.com'] }), resourceTypes: ['xmlhttprequest'] },
                }],
            });
            await ensureDocument();
            const jobId = crypto.randomUUID();
            log('已创建本地分析任务', { jobId });
            await chrome.storage.session.set({
                opedActiveJob: {
                    jobId,
                    startedAt: Date.now(),
                    prefetch: Boolean(backgroundEpisodeIds),
                    reportOnly,
                    episodeIds: execution.result.episodes.map(item => item.id),
                },
            });
            const response = await chrome.runtime.sendMessage({
                type: 'OPED_RUN', job: {
                    ...execution.result, settings: reportOnly ? { ...settings, mode: 'local' } : settings,
                    jobId, reportOnly,
                },
            });
            if (!response?.success) throw new Error('后台检测任务尚未结束，请稍后重试。');
            return reply({ enabled: true, pending: true });
        } catch (error) {
            await chrome.storage.session.remove('opedActiveJob');
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [120001] }).catch(() => {});
            await status(error.message || '检测启动失败。');
            if (backgroundEpisodeIds) {
                const session = await chrome.storage.session.get('opedFailedEpisodes');
                await chrome.storage.session.set({
                    opedFailedEpisodes: [...new Set([...(session.opedFailedEpisodes || []), ...backgroundEpisodeIds])],
                });
                scheduleNextBatch();
            }
            if (force) await chrome.storage.session.remove('opedForceQueue');
            return reply({ enabled: true, error: error.message });
        } finally { preparing = false; }
    }

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message.type === 'OPED_PAGE_CONTEXT') {
            if (!sender.tab?.id) return;
            chrome.tabs.get(sender.tab.id).then(tab => respond({ pageUrl: tab.url }), () => respond({}));
            return true;
        }
        if (message.type === 'OPED_START') {
            start(sender, message.pageUrl).then(respond, () => respond({
                pageUrl: message.pageUrl,
                episodeId: episodeId(message.pageUrl),
                error: '检测启动失败。',
            }));
            return true;
        }
        if (message.type === 'OPED_REDETECT') {
            (async () => {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.url) return { error: '请先打开支持的网站播放页。' };
                return start({ tab }, tab.url, null, true);
            })().then(respond, error => respond({ error: error.message }));
            return true;
        }
        const trusted = sender.url === chrome.runtime.getURL('oped-automation/extension/offscreen.html');
        if (!trusted || !['OPED_PROGRESS', 'OPED_LOG', 'OPED_COMPLETE', 'OPED_FAILED', 'OPED_HEARTBEAT', 'OPED_IDLE'].includes(message.type)) return;
        if (message.type === 'OPED_IDLE') {
            // The offscreen task has released its buffers and can accept another batch.
            scheduleNextBatch();
            respond({ success: true });
            return;
        }
        (async () => {
            const { opedActiveJob } = await chrome.storage.session.get('opedActiveJob');
            if (message.jobId !== opedActiveJob?.jobId) return;
            if (message.type === 'OPED_PROGRESS') await status(message.message);
            if (message.type === 'OPED_LOG') log(message.step, message.details || {});
            if (message.type === 'OPED_COMPLETE') {
                const saved = await chrome.storage.local.get(['opedResults', 'opedSettings']);
                if (!saved.opedSettings?.enabled) return;
                const results = saved.opedResults || {};
                let localRecordNote = '';
                try {
                    await SyncWatchOpedRecords.save(
                        message.metadata, message.result,
                        opedActiveJob.prefetch && !opedActiveJob.reportOnly,
                    );
                    log('已写入电脑本地记录文件', { file: 'oped-records.json' });
                } catch (error) {
                    localRecordNote = '电脑本地记录文件保存失败，浏览器缓存仍可使用。';
                    log('电脑本地记录文件保存失败', { message: error.message });
                }
                for (const episode of message.result?.episodes || []) {
                    if (!message.episodeIds.includes(episode.id)) continue;
                    // Preparing future episodes must not replace a usable current result.
                    if (opedActiveJob.prefetch && !opedActiveJob.reportOnly &&
                        hasFreshResult(results[episode.id])) continue;
                    const segments = (episode.segments || []).filter(item =>
                        ['opening', 'ending'].includes(item.type) && Number.isFinite(item.start) &&
                        Number.isFinite(item.end) && item.start >= 0 && item.end > item.start && item.end <= episode.duration);
                    results[episode.id] = { segments, savedAt: Date.now() };
                }
                const entries = Object.entries(results).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 100);
                await chrome.storage.local.set({ opedResults: Object.fromEntries(entries) });
                if (opedActiveJob.reportOnly) {
                    const session = await chrome.storage.session.get('opedForceQueue');
                    const forceQueue = session.opedForceQueue;
                    if (forceQueue?.seriesId === message.metadata?.seriesId) {
                        await chrome.storage.session.set({ opedForceQueue: {
                            ...forceQueue,
                            completed: [...new Set([...forceQueue.completed,
                                ...message.result.episodes.map(item => item.id)])],
                        } });
                    }
                }
                log('检测完成并已更新本地结果', {
                    episodes: message.result?.episodes?.length || 0,
                    recordStatus: message.recordStatus,
                });
                const recordNote = message.recordStatus === 'failed'
                    ? '云端上报失败。'
                    : message.recordStatus === 'pending_quorum' ? '已上报候选结果，等待更多独立来源确认。'
                        : message.recordStatus === 'pending_verification' ? '已上报结果，服务器正在独立核验。'
                        : message.recordStatus === 'promoted' ? '云端记录已自动更新。'
                        : message.recordStatus === 'saved' ? '已保存云端记录。' : '';
                await status(`本批检测完成；后续剧集将继续后台处理。${localRecordNote}${recordNote}`);
            }
            if (message.type === 'OPED_FAILED') {
                log('检测失败', { message: message.message });
                await status(message.message);
                // Avoid repeatedly downloading the same failed task in polling tabs.
                const session = await chrome.storage.session.get('opedFailedEpisodes');
                await chrome.storage.session.set({
                    opedFailedEpisodes: [...new Set([...(session.opedFailedEpisodes || []), ...opedActiveJob.episodeIds])],
                });
            }
            if (['OPED_COMPLETE', 'OPED_FAILED'].includes(message.type)) {
                await chrome.storage.session.remove('opedActiveJob');
                await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [120001] });
            }
        })().then(() => respond({ success: true }), () => respond({ success: false }));
        return true;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.opedSettings) return;
        clearTimeout(nextBatchTimer);
        nextBatchTimer = null;
        chrome.runtime.sendMessage({ type: 'OPED_CANCEL' }).catch(() => {});
        chrome.storage.session.remove(['opedActiveJob', 'opedFailedEpisodes', 'opedSeasonQueue', 'opedForceQueue']);
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [120001] });
    });
})();
