/* Render recognized ranges on the site's timeline without intercepting input. */
(() => {
    const trackSelectors = [
        '.bpx-player-progress-schedule',
        '.bpx-player-progress-schedule-wrap',
        '.squirtle-progress-totalline',
        '.bilibili-player-video-progress .bui-track-horizontal',
    ];

    function ranges(duration, segments) {
        if (!Number.isFinite(duration) || duration <= 0) return [];
        return segments.flatMap(segment => {
            if (!['opening', 'ending'].includes(segment.type) ||
                !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return [];
            const start = Math.max(0, segment.start);
            const end = Math.min(duration, segment.end);
            if (end <= start) return [];
            return [{ type: segment.type, left: start / duration * 100, width: (end - start) / duration * 100 }];
        });
    }

    function create(documentRef, windowRef) {
        let video = null;
        let events = null;
        let track = null;
        let host = null;
        let layer = null;
        let signature = '';
        let previousPosition = '';
        let previousPriority = '';
        let changedPosition = false;

        function detach() {
            host?.remove();
            if (changedPosition && track?.style.position === 'relative') {
                if (previousPosition) track.style.setProperty('position', previousPosition, previousPriority);
                else track.style.removeProperty('position');
            }
            host = null;
            layer = null;
            track = null;
            signature = '';
            changedPosition = false;
        }

        function findTrack() {
            // Search only the current player's ancestors, not the whole document.
            for (let root = video?.parentElement, depth = 0; root && depth < 10; root = root.parentElement, depth++) {
                for (const selector of trackSelectors) {
                    const candidate = root.querySelector(selector);
                    if (candidate) return candidate;
                }
                if (root === documentRef.body) break;
            }
            return null;
        }

        function refresh() {
            const recognition = windowRef.SyncWatchOpedClient;
            const valid = video?.isConnected && recognition?.enabled && !recognition.pending &&
                recognition.pageUrl === windowRef.location.href;
            const segments = valid ? ranges(video.duration, recognition.segments) : [];
            if (!segments.length) {
                if (host) detach();
                return;
            }
            const nextTrack = findTrack();
            if (!nextTrack) {
                if (host) detach();
                return;
            }
            if (track !== nextTrack || !host?.isConnected) {
                detach();
                track = nextTrack;
                previousPosition = track.style.position;
                previousPriority = track.style.getPropertyPriority('position');
                changedPosition = windowRef.getComputedStyle(track).position === 'static';
                if (changedPosition) track.style.setProperty('position', 'relative');
                host = documentRef.createElement('span');
                host.dataset.syncWatchOpedMarkers = '';
                host.setAttribute('aria-hidden', 'true');
                host.style.cssText = 'all:initial;display:block;position:absolute;left:0;right:0;top:50%;height:4px;transform:translateY(-50%);pointer-events:none;z-index:6;';
                const shadow = host.attachShadow({ mode: 'closed' });
                layer = documentRef.createElement('div');
                layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:2px;pointer-events:none;';
                shadow.append(layer);
                track.append(host);
            }
            const nextSignature = JSON.stringify(segments);
            if (signature === nextSignature) return;
            signature = nextSignature;
            layer.replaceChildren();
            for (const segment of segments) {
                const marker = documentRef.createElement('span');
                marker.style.cssText = 'position:absolute;top:0;bottom:0;pointer-events:none;box-shadow:inset 0 0 0 1px rgb(255 255 255 / 35%);';
                marker.style.left = `${segment.left}%`;
                marker.style.width = `${segment.width}%`;
                marker.style.background = segment.type === 'opening' ? '#fb7299' : '#ffb347';
                layer.append(marker);
            }
        }

        const unsubscribe = windowRef.SyncWatchOpedClient?.subscribe?.(refresh);
        return {
            refresh,
            setVideo(nextVideo) {
                if (nextVideo === video) return;
                events?.abort();
                video = nextVideo;
                events = new AbortController();
                for (const name of ['loadedmetadata', 'durationchange', 'emptied']) {
                    video?.addEventListener(name, refresh, { signal: events.signal });
                }
                refresh();
            },
            destroy() {
                events?.abort();
                unsubscribe?.();
                detach();
                video = null;
            },
        };
    }

    window.SyncWatchOpedProgress = { create, ranges };
})();
