/* OP/ED tasks own their storage and never change the room/player configuration. */
importScripts(
    'oped-automation/extension/local-record-store.js',
    'oped-automation/extension/season-queue.js',
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
        const isCurrentPage = () => location.origin === requestedPage.origin &&
            location.pathname === requestedPage.pathname;
        if (!isCurrentPage()) return { stale: true };
        async function api(path) {
            const response = await fetch(`https://api.bilibili.com${path}`, {
                credentials: 'include', signal: AbortSignal.timeout(25000),
            });
            const body = await response.json();
            if (body.code !== 0) throw new Error(`B站接口返回 ${body.code}，无法获取可访问的音轨。`);
            return body.result || body.data;
        }
        const match = location.pathname.match(/^\/bangumi\/play\/(ep|ss)(\d+)/);
        if (!match) throw new Error('目前仅支持 B 站番剧剧集页面。');
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

    function episodeId(url) {
        try {
            const parsed = new URL(url);
            return parsed.hostname === 'www.bilibili.com'
                ? parsed.pathname.match(/^\/bangumi\/play\/ep(\d+)/)?.[1] || ''
                : '';
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

    function queueSeason(sender, pageUrl) {
        const key = `${sender.tab.id}:${new URL(pageUrl).pathname}`;
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
        const [execution] = await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id, frameIds: [0] },
            world: 'MAIN',
            func: discoverEpisodes,
            args: [pageUrl, { catalogOnly: true }],
        });
        const catalog = execution?.result;
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
            'opedSeasonQueue', 'opedActiveJob', 'opedFailedEpisodes',
        ]);
        const queue = session.opedSeasonQueue;
        if (!queue || session.opedActiveJob) return;
        const known = new Set(Object.entries(saved.opedResults || {})
            .filter(([, value]) => hasFreshResult(value)).map(([id]) => id));
        try {
            for (const id of await SyncWatchOpedRecords.knownEpisodes(queue.seriesId)) known.add(id);
        } catch (error) {
            log('本地记录文件读取失败，使用浏览器缓存继续', { message: error.message });
        }
        const failed = session.opedFailedEpisodes || [];
        const episodeIds = SyncWatchOpedQueue.nextBatch(queue.episodeOrder, [...known], failed);
        if (!episodeIds.length) {
            await status('当前番剧的可检测剧集已处理完成；结果已缓存。');
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

    async function start(sender, pageUrl, backgroundEpisodeIds = null) {
        const url = new URL(pageUrl || 'https://invalid.local');
        const id = episodeId(url.href);
        const reply = (result) => ({ pageUrl: url.href, episodeId: id, ...result });
        const saved = await chrome.storage.local.get(['opedSettings', 'opedResults']);
        const settings = { ...defaults, ...saved.opedSettings };
        log('收到识别请求', { mode: settings.mode, enabled: settings.enabled, episodeId: id });
        if (!settings.enabled) return reply({ enabled: false });
        if (!sender.tab || url.hostname !== 'www.bilibili.com' || !/^\/bangumi\/play\/(ep|ss)\d+/.test(url.pathname)) {
            return reply({ enabled: true, unsupported: true });
        }
        // SPA navigation can leave sender.url pointing at the original episode.
        // Verify the explicitly requested route against the browser's live tab URL.
        const tab = await chrome.tabs.get(sender.tab.id);
        const liveUrl = new URL(tab.url || 'https://invalid.local');
        if (liveUrl.origin !== url.origin || liveUrl.pathname !== url.pathname) {
            log('剧集已切换，忽略旧页面请求', { episodeId: id });
            return reply({ enabled: true, pending: true });
        }
        const cached = backgroundEpisodeIds ? null : await cachedEpisode(id, saved.opedResults);
        if (cached) {
            log('使用本地缓存结果', { episodeId: id, segments: cached.segments });
            queueSeason(sender, url.href);
            return reply({ enabled: true, segments: cached.segments });
        }
        const { opedActiveJob, opedFailedEpisodes } = await chrome.storage.session.get(['opedActiveJob', 'opedFailedEpisodes']);
        if (!backgroundEpisodeIds && id && opedFailedEpisodes?.includes(id)) {
            return reply({ enabled: true, error: '检测失败；调整配置后重新开启识别可重试。' });
        }
        if (preparing || (opedActiveJob && Date.now() - opedActiveJob.startedAt < 16 * 60000)) {
            return reply({ enabled: true, pending: true });
        }
        preparing = true;
        try {
            if (settings.mode === 'cloud') {
                const server = new URL(settings.server);
                if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(server.hostname))) {
                    throw new Error('云端地址需要 HTTPS，本机可使用 HTTP。');
                }
                if (!settings.token) throw new Error('请填写云端检测密钥。');
            }
            await status(backgroundEpisodeIds
                ? '正在后台提前识别后续剧集的片头片尾…'
                : '正在获取番剧目录和低码率音轨…');
            log('开始获取番剧目录和三集低码率音轨信息');
            const [execution] = await chrome.scripting.executeScript({
                target: { tabId: sender.tab.id, frameIds: [0] }, world: 'MAIN', func: discoverEpisodes,
                args: [url.href, { episodeIds: backgroundEpisodeIds }],
            });
            if (execution?.result?.stale) {
                if (backgroundEpisodeIds) scheduleNextBatch();
                return reply({ enabled: true, pending: true });
            }
            if (!execution?.result?.episodes) throw new Error('无法读取番剧音轨，请确认当前账号可播放这三集。');
            log('番剧目录和音轨信息获取完成', {
                series: execution.result.metadata.title,
                episodes: execution.result.episodes.map(item => ({ number: item.number, bandwidth: item.bandwidth })),
            });
            await saveSeasonQueue(execution.result.catalog, sender.tab.id);
            const resolvedCache = backgroundEpisodeIds ? null :
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
            // Only extension-origin CDN requests receive the site's required referer.
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [120001],
                addRules: [{
                    id: 120001, priority: 1,
                    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' }] },
                    condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['bilivideo.com'], resourceTypes: ['xmlhttprequest'] },
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
                    episodeIds: execution.result.episodes.map(item => item.id),
                },
            });
            const response = await chrome.runtime.sendMessage({
                type: 'OPED_RUN', job: { ...execution.result, settings, jobId },
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
            return reply({ enabled: true, error: error.message });
        } finally { preparing = false; }
    }

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message.type === 'OPED_START') {
            start(sender, message.pageUrl).then(respond, () => respond({
                pageUrl: message.pageUrl,
                episodeId: episodeId(message.pageUrl),
                error: '检测启动失败。',
            }));
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
                        message.metadata, message.result, opedActiveJob.prefetch,
                    );
                    log('已写入电脑本地记录文件', { file: 'oped-records.json' });
                } catch (error) {
                    localRecordNote = '电脑本地记录文件保存失败，浏览器缓存仍可使用。';
                    log('电脑本地记录文件保存失败', { message: error.message });
                }
                for (const episode of message.result?.episodes || []) {
                    if (!message.episodeIds.includes(episode.id)) continue;
                    // Preparing future episodes must not replace a usable current result.
                    if (opedActiveJob.prefetch && hasFreshResult(results[episode.id])) continue;
                    const segments = (episode.segments || []).filter(item =>
                        ['opening', 'ending'].includes(item.type) && Number.isFinite(item.start) &&
                        Number.isFinite(item.end) && item.start >= 0 && item.end > item.start && item.end <= episode.duration);
                    results[episode.id] = { segments, savedAt: Date.now() };
                }
                const entries = Object.entries(results).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 100);
                await chrome.storage.local.set({ opedResults: Object.fromEntries(entries) });
                log('检测完成并已更新本地结果', {
                    episodes: message.result?.episodes?.length || 0,
                    recordStatus: message.recordStatus,
                });
                const recordNote = message.recordStatus === 'failed'
                    ? '云端记录保存失败。'
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
        chrome.storage.session.remove(['opedActiveJob', 'opedFailedEpisodes', 'opedSeasonQueue']);
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [120001] });
    });
})();
