(() => {
    if (window !== window.top || window.SyncWatchOpedClient) return;
    const client = window.SyncWatchOpedClient = { enabled: false, segments: [] };
    let previousUrl = '';
    let requestedAt = 0;
    let pending = false;
    let busy = false;
    let refreshQueued = false;
    let timer;
    let settingEnabled = false;

    function refreshAvailability() {
        client.enabled = settingEnabled && location.hostname === 'www.bilibili.com' &&
            /^\/bangumi\/play\/(ep|ss)\d+/.test(location.pathname);
    }

    async function update(force = false) {
        if (busy) {
            refreshQueued ||= force;
            return;
        }
        if (location.href !== previousUrl) {
            previousUrl = location.href;
            requestedAt = 0;
            client.segments = [];
            refreshAvailability();
        }
        if (!force && requestedAt && (!pending || Date.now() - requestedAt < 15000)) return;
        busy = true;
        const page = location.href;
        try {
            requestedAt = Date.now();
            const reply = await chrome.runtime.sendMessage({ type: 'OPED_START' });
            if (page !== location.href) return;
            client.enabled = settingEnabled && reply?.enabled === true && !reply?.unsupported;
            client.segments = reply?.segments || [];
            pending = reply?.pending === true;
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
