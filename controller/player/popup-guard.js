/* Run in the page world before site scripts can capture window.open. */
(() => {
    const policy = globalThis.SyncWatchStreamingAdPolicy;
    if (!policy?.applies(window) || window.__syncWatchPopupGuard) return;
    Object.defineProperty(window, '__syncWatchPopupGuard', { value: true });
    const nativeOpen = window.open;
    let enabled = true;
    let allowedLink = null;
    let allowedAt = 0;

    function inspect(event) {
        allowedLink = null;
        if (!enabled) return;
        const elements = event.composedPath().filter(node => node instanceof Element);
        const anchor = elements.find(node => node.tagName === 'A' && node.hasAttribute('href'));
        let destination;
        try { if (anchor) destination = new URL(anchor.href, location.href); } catch {}
        const playerLink = destination && elements.some(node => node.matches(policy.playerSelector)) &&
            (destination.origin !== location.origin || policy.redirected(destination));
        const scriptedExternalLink = !event.isTrusted && destination && destination.origin !== location.origin;
        if (elements.some(policy.marked) || playerLink || scriptedExternalLink) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.isTrusted && destination && ['https:', 'http:'].includes(destination.protocol)) {
            // Allow a script to open only the link the user actually selected.
            allowedLink = destination.href;
            allowedAt = performance.now();
        }
    }

    for (const name of ['pointerdown', 'click', 'auxclick']) window.addEventListener(name, inspect, true);
    window.open = function (url, target, features) {
        if (!enabled) return Reflect.apply(nativeOpen, this, arguments);
        let destination;
        try { destination = new URL(String(url || ''), location.href); } catch { return null; }
        if (allowedLink && performance.now() - allowedAt < 1000 && destination.href === allowedLink) {
            allowedLink = null;
            return Reflect.apply(nativeOpen, this, arguments);
        }
        // A playback click is not permission for a site script to open an ad tab.
        return null;
    };
    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.type !== 'SYNC_WATCH_AD_GUARD_SETTINGS' ||
            typeof event.data.enabled !== 'boolean') return;
        enabled = event.data.enabled;
        allowedLink = null;
    });
    window.postMessage({ type: 'SYNC_WATCH_AD_GUARD_READY' }, '*');
})();
