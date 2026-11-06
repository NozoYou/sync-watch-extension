(() => {
    if (window.SyncWatchOpedClient) return;
    const client = window.SyncWatchOpedClient = { enabled: false, segments: [], pageUrl: '', pending: false };
    let sourcePage = window === window.top ? location.href : '';
    let previousUrl = '';
    let requestedAt = 0;
    let pending = false;
    let busy = false;
    let refreshQueued = false;
    let timer;
    let settingEnabled = false;
    let pageVersion = 0;
    const subscribers = new Set();
    client.subscribe = (listener) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
    };

    function notify() {
        for (const listener of subscribers) listener();
    }

    function refreshAvailability() {
        if (!sourcePage) { client.enabled = false; return; }
        const url = new URL(sourcePage);
        client.enabled = settingEnabled && Boolean(window.SyncWatchStreamingSites?.identify(sourcePage) ||
            (url.hostname === 'www.bilibili.com' && (/^\/bangumi\/play\/(ep|ss)\d+/.test(url.pathname) ||
                /^\/video\/BV[0-9A-Za-z]{10}(?:\/|$)/.test(url.pathname))));
    }

    function pageEpisodeId(url) {
        const streaming = window.SyncWatchStreamingSites?.identify(url);
        if (streaming) return streaming.episodeId;
        const parsed = new URL(url);
        const video = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
        if (video) {
            const part = Number(parsed.searchParams.get('p') || 1);
            return `ugc:${video[1]}:p${Number.isInteger(part) && part > 0 ? part : 1}`;
        }
        return parsed.pathname.match(/^\/bangumi\/play\/ep(\d+)/)?.[1] || '';
    }

    async function update(force = false) {
        if (busy) { refreshQueued ||= force; return; }
        try {
            sourcePage = window === window.top ? location.href :
                (await chrome.runtime.sendMessage({ type: 'OPED_PAGE_CONTEXT' }))?.pageUrl || '';
        } catch { return; }
        if (!sourcePage) return;
        if (sourcePage !== previousUrl) {
            previousUrl = sourcePage;
            pageVersion += 1;
            requestedAt = 0;
            client.segments = [];
            client.pageUrl = '';
            client.pending = true;
            pending = true;
            refreshAvailability();
            notify();
            force = true;
        }
        if (busy) {
            refreshQueued ||= force;
            return;
        }
        if (!force && requestedAt && (!pending || Date.now() - requestedAt < 15000)) return;
        busy = true;
        const page = sourcePage;
        const version = pageVersion;
        try {
            requestedAt = Date.now();
            const reply = await chrome.runtime.sendMessage({ type: 'OPED_START', pageUrl: page });
            if ((window === window.top && page !== location.href) || page !== sourcePage || version !== pageVersion) return;
            // Never apply a result returned for another episode or an earlier route.
            const currentId = pageEpisodeId(page);
            if (reply?.pageUrl !== page || (currentId && reply.episodeId !== currentId)) {
                pending = true;
                client.segments = [];
                client.pending = true;
                notify();
                return;
            }
            client.enabled = settingEnabled && reply?.enabled === true && !reply?.unsupported;
            client.segments = reply?.segments || [];
            client.pageUrl = location.href;
            client.sourcePageUrl = page;
            pending = reply?.pending === true;
            client.pending = pending;
            notify();
        } catch {
            clearInterval(timer);
        } finally {
            busy = false;
            if (refreshQueued) {
                refreshQueued = false;
                void update(true);
            }
        }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.opedSettings) {
            settingEnabled = changes.opedSettings.newValue?.enabled === true;
            refreshAvailability();
            notify();
        }
        if (area === 'local' && (changes.opedSettings || changes.opedResults)) void update(true);
    });
    timer = setInterval(() => void update(), 1500);
    chrome.storage.local.get('opedSettings').then(saved => {
        settingEnabled = saved.opedSettings?.enabled === true;
        refreshAvailability();
        void update(true);
    });
})();
