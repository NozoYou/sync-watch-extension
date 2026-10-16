/* OP/ED tasks own their storage and never change the room/player configuration. */
(() => {
    const defaults = { enabled: false, mode: 'local', server: '', token: '' };
    let preparing = false;
    let creation = null;

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
    async function discoverEpisodes() {
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
        const current = episodes.find(item => item.id === currentId);
        if (!current || episodes.length < 3) throw new Error('未找到当前集及另外两集连续正片。');
        const references = episodes.filter(item => item.id !== currentId)
            .sort((a, b) => Math.abs(Number(a.title) - Number(current.title)) - Math.abs(Number(b.title) - Number(current.title)))
            .slice(0, 2);
        const selected = [current, ...references];
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
        return {
            currentId: String(currentId), episodes: result,
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

    async function start(sender) {
        const saved = await chrome.storage.local.get(['opedSettings', 'opedResults']);
        const settings = { ...defaults, ...saved.opedSettings };
        if (!settings.enabled) return { enabled: false };
        const url = new URL(sender.url || 'https://invalid.local');
        if (!sender.tab || url.hostname !== 'www.bilibili.com' || !/^\/bangumi\/play\/(ep|ss)\d+/.test(url.pathname)) {
            return { enabled: true, unsupported: true };
        }
        const id = episodeId(sender.url);
        const cached = saved.opedResults?.[id];
        if (cached && Date.now() - cached.savedAt < 7 * 86400000) return { enabled: true, segments: cached.segments };
        const { opedActiveJob, opedFailedEpisodes } = await chrome.storage.session.get(['opedActiveJob', 'opedFailedEpisodes']);
        if (id && opedFailedEpisodes?.includes(id)) {
            return { enabled: true, error: '检测失败；调整配置后重新开启识别可重试。' };
        }
        if (preparing || (opedActiveJob && Date.now() - opedActiveJob.startedAt < 16 * 60000)) {
            return { enabled: true, pending: true };
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
            await status('正在获取番剧目录和低码率音轨…');
            const [execution] = await chrome.scripting.executeScript({
                target: { tabId: sender.tab.id, frameIds: [0] }, world: 'MAIN', func: discoverEpisodes,
            });
            if (!execution?.result?.episodes) throw new Error('无法读取番剧音轨，请确认当前账号可播放这三集。');
            const resolvedCache = saved.opedResults?.[execution.result.currentId];
            if (resolvedCache && Date.now() - resolvedCache.savedAt < 7 * 86400000) {
                return { enabled: true, segments: resolvedCache.segments };
            }
            const latest = await chrome.storage.local.get('opedSettings');
            if (!latest.opedSettings?.enabled) return { enabled: false };
            if (JSON.stringify({ ...defaults, ...latest.opedSettings }) !== JSON.stringify(settings)) {
                return { enabled: true, pending: true };
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
            await chrome.storage.session.set({
                opedActiveJob: { jobId, startedAt: Date.now(), episodeIds: execution.result.episodes.map(item => item.id) },
            });
            const response = await chrome.runtime.sendMessage({
                type: 'OPED_RUN', job: { ...execution.result, settings, jobId },
            });
            if (!response?.success) throw new Error('后台检测任务尚未结束，请稍后重试。');
            return { enabled: true, pending: true };
        } catch (error) {
            await chrome.storage.session.remove('opedActiveJob');
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [120001] }).catch(() => {});
            await status(error.message || '检测启动失败。');
            return { enabled: true, error: error.message };
        } finally { preparing = false; }
    }

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message.type === 'OPED_START') {
            start(sender).then(respond, () => respond({ error: '检测启动失败。' }));
            return true;
        }
        const trusted = sender.url === chrome.runtime.getURL('oped-automation/extension/offscreen.html');
        if (!trusted || !['OPED_PROGRESS', 'OPED_COMPLETE', 'OPED_FAILED', 'OPED_HEARTBEAT'].includes(message.type)) return;
        (async () => {
            const { opedActiveJob } = await chrome.storage.session.get('opedActiveJob');
            if (message.jobId !== opedActiveJob?.jobId) return;
            if (message.type === 'OPED_PROGRESS') await status(message.message);
            if (message.type === 'OPED_COMPLETE') {
                const saved = await chrome.storage.local.get(['opedResults', 'opedSettings']);
                if (!saved.opedSettings?.enabled) return;
                const results = saved.opedResults || {};
                for (const episode of message.result?.episodes || []) {
                    if (!message.episodeIds.includes(episode.id)) continue;
                    const segments = (episode.segments || []).filter(item =>
                        ['opening', 'ending'].includes(item.type) && Number.isFinite(item.start) &&
                        Number.isFinite(item.end) && item.start >= 0 && item.end > item.start && item.end <= episode.duration);
                    results[episode.id] = { segments, savedAt: Date.now() };
                }
                const entries = Object.entries(results).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 100);
                await chrome.storage.local.set({ opedResults: Object.fromEntries(entries) });
                const recordNote = message.recordStatus === 'failed'
                    ? '云端记录保存失败。'
                    : message.recordStatus === 'saved' ? '已保存云端记录。' : '';
                await status(`检测完成；未匹配的片头或片尾不提供跳过。${recordNote}`);
            }
            if (message.type === 'OPED_FAILED') {
                await status(message.message);
                // Avoid repeatedly downloading the same failed task in polling tabs.
                await chrome.storage.session.set({ opedFailedEpisodes: opedActiveJob.episodeIds });
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
        chrome.runtime.sendMessage({ type: 'OPED_CANCEL' }).catch(() => {});
        chrome.storage.session.remove(['opedActiveJob', 'opedFailedEpisodes']);
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [120001] });
    });
})();
