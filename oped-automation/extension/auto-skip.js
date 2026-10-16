/* Only the host's bound player may initiate automatic room-wide OP/ED seeks. */
(() => {
    const controller = (window.SyncWatchController ||= {});

    function create(actions) {
        let state = {};
        let identity = null;
        let video = null;
        let events = null;
        let playbackKey = '';
        const skipped = new Set();

        function check() {
            const key = `${state.room || ''}:${location.href}`;
            if (key !== playbackKey) {
                playbackKey = key;
                skipped.clear();
            }
            if (!state.room || !state.connected || state.role !== 'host' || !state.autoSkipOped) return;
            if (state.videoReady !== true) return;
            if (!identity || identity.tabId !== state.tabId || identity.frameId !== (state.videoFrameId ?? 0)) return;
            if (!video || video.paused || video.seeking || video.ended || video.readyState < 2) return;
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;

            const recognition = window.SyncWatchOpedClient;
            if (!recognition?.enabled || recognition.pending || recognition.pageUrl !== location.href) return;
            const segment = recognition.segments.find(item =>
                video.currentTime >= item.start && video.currentTime < item.end);
            if (!segment) return;
            const segmentKey = `${segment.type}:${segment.start}:${segment.end}`;
            if (skipped.has(segmentKey)) return;
            const target = controller.skipSegments.getTargetTime(video, segment);
            // The last three seconds are intentionally played, never sought backward.
            skipped.add(segmentKey);
            if (target <= video.currentTime) return;
            if (!actions.skipOpeningEnding(85, state)) skipped.delete(segmentKey);
        }

        function setVideo(nextVideo) {
            if (video === nextVideo) return;
            events?.abort();
            video = nextVideo;
            skipped.clear();
            events = video ? new AbortController() : null;
            for (const name of ['timeupdate', 'playing', 'seeked', 'loadedmetadata']) {
                video?.addEventListener(name, check, { signal: events.signal });
            }
            check();
        }

        return {
            setVideo,
            update(nextState, nextIdentity) {
                state = { ...state, ...nextState };
                if (nextIdentity) identity = nextIdentity;
                check();
            },
            destroy() {
                events?.abort();
                video = null;
                skipped.clear();
            },
        };
    }

    controller.autoSkip = { create };
})();
