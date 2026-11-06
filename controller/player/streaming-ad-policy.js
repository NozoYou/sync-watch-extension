/* Shared rules for streaming-site popup protection in both script worlds. */
(() => {
    if (globalThis.SyncWatchStreamingAdPolicy) return;
    const hostPattern = /(?:^|\.)(?:age\.tv|agefans\.[a-z.]+|agedm\.[a-z.]+|agespa-[\w-]+\.[a-z.]+|(?:yhdm|yinghuacd|imomoe|sakura(?:dm|anime)?|omofun|omofunn)\.[a-z.]+)$/i;
    const selectors = [
        '[class~="ad"]', '[class~="ads"]', '[id="ad"]', '[id="ads"]',
        '[id^="popup_ad" i]', '[class*="popup-ad" i]', '[class*="banner-ad" i]',
        '[id^="popunder" i]', '[class*="popunder" i]',
        '[data-ad-overlay]', '[data-ad-popup]',
        '#HMimageleft', '#HMimageright', '#HMRichBox',
        'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]',
    ];
    const playerSelector = 'video, media-controller, [class*="player" i], [id*="player" i], .art-video-player';
    const markerPattern = /(?:^|[-_\s])(ad|ads|advert|advertisement|sponsor|promoted|popunder)(?:$|[-_\s])/i;

    function applies(windowRef) {
        const origins = [windowRef.location.href];
        // Chrome exposes origins even when an embedded player is cross-origin.
        for (const origin of windowRef.location.ancestorOrigins || []) origins.push(origin);
        if (windowRef.document?.referrer) origins.push(windowRef.document.referrer);
        return origins.some(value => {
            try { return hostPattern.test(new URL(value).hostname); } catch { return false; }
        });
    }

    function marked(element) {
        if (typeof element?.matches !== 'function') return false;
        if (element.matches('[data-ad], [data-ad-slot], [data-advertisement], [data-ad-overlay], [data-ad-popup]')) return true;
        return markerPattern.test(`${element.id || ''} ${element.getAttribute('class') || ''}`);
    }

    function redirected(url) {
        return /(?:adclick|clickout|\/out\/|\/go\/)/i.test(url.pathname) ||
            ['url', 'target', 'to'].some(key => url.searchParams.has(key));
    }

    globalThis.SyncWatchStreamingAdPolicy = { applies, marked, redirected, selectors, playerSelector };
})();
