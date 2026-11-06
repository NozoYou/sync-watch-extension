/* Relay extension settings to the early page-world popup guard. */
(() => {
    if (!globalThis.SyncWatchStreamingAdPolicy?.applies(window) || window.__syncWatchAdGuardSettings) return;
    window.__syncWatchAdGuardSettings = true;
    let enabled = true;
    const send = () => window.postMessage({ type: 'SYNC_WATCH_AD_GUARD_SETTINGS', enabled }, '*');
    window.addEventListener('message', event => {
        if (event.source === window && event.data?.type === 'SYNC_WATCH_AD_GUARD_READY') send();
    });
    chrome.storage.local.get('controllerSettings').then(saved => {
        enabled = saved.controllerSettings?.blockAds !== false;
        send();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.controllerSettings) return;
        enabled = changes.controllerSettings.newValue?.blockAds !== false;
        send();
    });
})();
