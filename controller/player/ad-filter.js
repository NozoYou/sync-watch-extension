(() => {
    const namespace = (window.SyncWatchAdFilter ||= {});

    function create(documentRef = document, windowRef = window) {
        const style = documentRef.createElement('style');
        style.dataset.syncWatchAdFilter = 'true';
        const observer = new MutationObserver(scheduleScan);
        const eventController = new AbortController();
        let enabled = true;
        let blockPromotions = true;
        let scanTimer = null;
        let feedWakeTimer = null;
        let feedWakeRequested = false;

        const commonAdSelectors = [
            '[data-ad]',
            '[data-ad-slot]',
            '[data-advertisement]',
            '[aria-label*="广告"]',
            '[aria-label^="Advertisement" i]',
            '[aria-label^="Sponsored" i]',
            'ins.adsbygoogle',
            'iframe[src*="doubleclick.net"]',
            'iframe[src*="googlesyndication.com"]',
            '.ad-container',
            '.ads-container',
            '.advertisement',
            '.sponsored-content',
        ];

        function selectorsForPage() {
            const host = windowRef.location.hostname;

            if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
                return [
                    ...commonAdSelectors,
                    '.ad-report',
                    '.ad-floor-exp',
                    '#slide_ad',
                    '#bili_report_spe_rec',
                    '.bili-dyn-ads',
                    '.video-ad-creative-card',
                    '.video-page-special-card-small',
                    '.video-page-game-card',
                    '.bpx-player-ad',
                    '.bpx-player-video-ad',
                    '.bpx-player-dm-ad',
                ];
            }

            if (/(?:^|\.)(?:yhdm|yinghuacd|imomoe|sakura(?:dm|anime)?)(?:\.|$)/i.test(host)) {
                return [
                    ...commonAdSelectors,
                    '#HMimageleft',
                    '#HMimageright',
                    '#HMRichBox',
                    '[id*="popup_ad" i]',
                    '[class*="popup-ad" i]',
                ];
            }

            if (/(?:^|\.)(?:age\.tv|agefans\.[a-z.]+|agedm\.[a-z.]+|agespa-[\w-]+\.[a-z.]+)$/i.test(host)) {
                return [
                    ...commonAdSelectors,
                    '.global_notice_box',
                    '.global_notice_wrapper',
                    'a.nav-download-link',
                    '.text_list_box.links',
                    '.ad-report',
                    '#slide_ad',
                ];
            }

            if (/(?:^|\.)(?:omofun|omofunn)(?:\.[a-z.]+)$/i.test(host)) {
                return [
                    ...commonAdSelectors,
                    '[class~="ad"]',
                    '[class~="ads"]',
                    '[id~="ad"]',
                    '[id~="ads"]',
                    '[class*="banner-ad" i]',
                    '[class*="popup-ad" i]',
                ];
            }

            if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
                return [
                    ...commonAdSelectors,
                    '.video-ads',
                    '.ytp-ad-overlay-container',
                    '.ytp-ad-player-overlay',
                ];
            }

            return commonAdSelectors;
        }

        function scheduleScan() {
            if (!enabled || scanTimer !== null) return;
            scanTimer = windowRef.setTimeout(() => {
                scanTimer = null;
                removeBilibiliAdCards();
                skipAvailableVideoAds();
            }, 300);
        }

        function isBilibiliPromotionIcon(icon) {
            // The statistics icon class is also used for views and comments.
            // Check all four paths of the supplied rocket instead of that class alone.
            const pathSignatures = [
                'M16.9122 1.50323C17.4366 1.48358',
                'M9.11924 19.72695C9.32694 19.36935',
                'M7.54619 17.96085C7.18746 17.7549',
                'M15.30435 8.02718C15.6036 8.2',
            ];
            const paths = [...icon.querySelectorAll('path')];
            return icon.getAttribute('viewBox') === '0 0 24 24' &&
                paths.length === pathSignatures.length &&
                paths.every((path, index) => {
                    const data = (path.getAttribute('d') || '')
                        .trim()
                        .replace(/\s+/g, ' ');
                    return data.startsWith(pathSignatures[index]);
                });
        }

        function removeBilibiliAdCards() {
            const host = windowRef.location.hostname;
            if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) return;
            let removed = false;

            for (const marker of documentRef.querySelectorAll(
                [
                    '.bili-video-card__stats--text',
                    'svg.bili-video-card__stats--icon',
                    '.floor-single-card .badge .floor-title',
                    '.channel-icon span',
                    '.channel.icon span',
                ].join(', '),
            )) {
                const isAdLabel = marker.matches('.bili-video-card__stats--text') &&
                    marker.textContent.trim() === '广告';
                const isPromotion = blockPromotions &&
                    marker.matches('svg.bili-video-card__stats--icon') &&
                    isBilibiliPromotionIcon(marker);
                // Match the channel badge, never a video title containing this word.
                const isClassroom = marker.textContent.trim() === '课堂' && (
                    marker.matches('.channel-icon span, .channel.icon span') ||
                    (marker.matches('.floor-single-card .badge .floor-title') &&
                        marker.closest('.badge')?.querySelector('svg[id^="channel-icon"]'))
                );
                if (!isAdLabel && !isPromotion && !isClassroom) continue;
                const card = marker.closest('.bili-video-card, .floor-single-card');
                if (!card) continue;

                // Remove the entire ad slot and let the site's feed handle layout.
                const container = card.closest('.feed-card') ||
                    card.closest('.floor-single-card') ||
                    card.closest('.bili-feed-card') || card;
                if (!container.isConnected) continue;
                container.remove();
                removed = true;
            }
            if (removed) wakeHomepageFeed();
        }

        function wakeHomepageFeed() {
            // Skeleton cards belong to the site's lazy loader, not the ad filter.
            if (windowRef.location.pathname !== '/' || feedWakeRequested) return;
            feedWakeRequested = true;
            feedWakeTimer = windowRef.setTimeout(() => {
                feedWakeTimer = null;
                if (!enabled || documentRef.hidden) return;
                // Notify scroll listeners without changing the viewport position.
                windowRef.dispatchEvent(new windowRef.Event('scroll'));
                documentRef.dispatchEvent(new windowRef.Event('scroll'));
            }, 300);
        }

        function skipAvailableVideoAds() {
            const host = windowRef.location.hostname;
            if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return;

            for (const selector of [
                '.ytp-ad-skip-button',
                '.ytp-skip-ad-button',
                '.ytp-ad-skip-button-modern',
            ]) {
                for (const button of documentRef.querySelectorAll(selector)) {
                    if (!button.disabled && button.getClientRects().length) {
                        button.click();
                        return;
                    }
                }
            }
        }

        function isAdMarked(element) {
            if (!(element instanceof windowRef.Element)) return false;
            if (element.matches(
                '[data-ad], [data-ad-slot], [data-advertisement], [aria-label*="广告"], [aria-label^="Advertisement" i], [aria-label^="Sponsored" i]',
            )) {
                return true;
            }

            const markerPattern = /(?:^|[-_\s])(ad|ads|advert|advertisement|sponsor|promoted)(?:$|[-_\s])/i;
            return markerPattern.test(`${element.id} ${element.className}`);
        }

        function blockAdClick(event) {
            if (!enabled || !event.isTrusted) return;

            const path = event.composedPath();
            const elements = path.filter(
                (node) => node instanceof windowRef.Element,
            );
            const adTarget = elements.some(isAdMarked);
            const anchor = elements.find(
                (element) => element.tagName === 'A' && element.hasAttribute('href'),
            );
            let externalPlayerLink = false;

            if (anchor) {
                try {
                    const destination = new URL(anchor.href, windowRef.location.href);
                    const pathLooksLikeRedirect =
                        /(?:adclick|redirect|clickout|\/out\/|\/go\/)/i.test(
                            destination.pathname,
                        ) || ['url', 'target', 'to'].some((key) =>
                            destination.searchParams.has(key),
                        );
                    const insidePlayer = elements.some((element) =>
                        element.matches(
                            'video, media-controller, [class*="player" i], [id*="player" i]',
                        ),
                    );
                    externalPlayerLink = insidePlayer &&
                        (destination.origin !== windowRef.location.origin ||
                            pathLooksLikeRedirect);
                } catch {
                    // Ignore malformed links and leave the site's normal handler intact.
                }
            }

            if (!adTarget && !externalPlayerLink) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }

        documentRef.addEventListener('click', blockAdClick, {
            capture: true,
            signal: eventController.signal,
        });
        documentRef.addEventListener('auxclick', blockAdClick, {
            capture: true,
            signal: eventController.signal,
        });

        function setEnabled(nextEnabled) {
            enabled = nextEnabled !== false;
            if (enabled) {
                const host = windowRef.location.hostname;
                const isBilibili = host === 'bilibili.com' ||
                    host.endsWith('.bilibili.com');
                const selectors = selectorsForPage().join(',\n');
                // Video cards are handled separately using the exact ad label.
                const cardExclusions = isBilibili
                    ? ':not(.feed-card):not(.bili-video-card):not(.feed-card *):not(.bili-video-card *)'
                    : '';
                style.textContent = `
                    :is(${selectors})${cardExclusions} {
                        display: none !important;
                    }
                `;
                if (!style.isConnected) {
                    (documentRef.head || documentRef.documentElement).append(style);
                }
                observer.observe(documentRef.documentElement, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                });
                scheduleScan();
            } else {
                observer.disconnect();
                windowRef.clearTimeout(scanTimer);
                windowRef.clearTimeout(feedWakeTimer);
                scanTimer = null;
                feedWakeTimer = null;
                style.remove();
            }
        }

        function setSettings(settings = {}) {
            blockPromotions = settings.blockPromotions !== false;
            setEnabled(settings.blockAds !== false);
        }

        // Wait for saved preferences before removing page content.
        setEnabled(false);

        return {
            setEnabled,
            setSettings,
            destroy() {
                observer.disconnect();
                eventController.abort();
                windowRef.clearTimeout(scanTimer);
                windowRef.clearTimeout(feedWakeTimer);
                style.remove();
            },
        };
    }

    namespace.create = create;
})();
