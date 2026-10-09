(() => {
    // Avoid installing duplicate listeners if the page injects this script again.
    if (window.__syncWatchLoaded) return;
    window.__syncWatchLoaded = true;

    const isTop = window === window.top;
    const expectedMediaEvents = new WeakMap();

    let video = null;
    let lastTimeSent = 0;
    let lastFrameReport = '';
    let role = '';
    let autoPauseTimer = null;
    let lastAutoPauseId = '';
    let tabMarkerEnabled = false;
    let tabIconEnabled = false;
    let originalPageTitle = '';
    let decoratedPageTitle = '';
    let tabMarkerObserver = null;

    const tabTitlePrefix = '[一起看] ';
    const tabIconId = '__sync_watch_tab_icon';

    function chooseVideo() {
        const videos = [...document.querySelectorAll('video')];
        const readyVideos = videos
            .filter((candidate) => candidate.readyState > 0)
            .sort(
                (a, b) =>
                    b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight,
            );

        // Prefer a loaded, larger video when a page contains more than one player.
        return readyVideos[0] || videos[0] || null;
    }

    function videoState(currentVideo, action = 'snapshot') {
        return {
            action,
            time: Number(currentVideo.currentTime) || 0,
            duration: Number.isFinite(currentVideo.duration)
                ? currentVideo.duration
                : 0,
            paused: currentVideo.paused,
            rate: currentVideo.playbackRate,
            at: Date.now(),
            url: location.href,
            title: (document.title || location.hostname).replace(
                /^\[一起看\]\s*/,
                '',
            ),
        };
    }

    // Mark events caused by a remote update so they are not sent back as user input.
    function expectMediaEvent(currentVideo, key, value) {
        let expected = expectedMediaEvents.get(currentVideo);

        if (!expected) {
            expected = {};
            expectedMediaEvents.set(currentVideo, expected);
        }

        expected[key] = {
            value,
            expires: Date.now() + 1800,
        };
    }

    function isExpectedMediaEvent(currentVideo, action) {
        const expected = expectedMediaEvents.get(currentVideo);
        if (!expected) return false;

        const now = Date.now();

        for (const key of Object.keys(expected)) {
            if (expected[key].expires < now) delete expected[key];
        }

        const key =
            action === 'play' || action === 'pause'
                ? 'paused'
                : action === 'ratechange'
                  ? 'rate'
                  : action === 'seeking' || action === 'seeked'
                    ? 'time'
                    : '';
        const entry = key && expected[key];
        if (!entry) return false;

        const matches =
            key === 'paused'
                ? currentVideo.paused === entry.value
                : key === 'rate'
                  ? Math.abs(currentVideo.playbackRate - entry.value) < 0.03
                  : Math.abs(currentVideo.currentTime - entry.value) < 1.25;

        if (!matches) {
            delete expected[key];
            return false;
        }

        // A seek can emit both "seeking" and "seeked"; keep the marker until it ends.
        if (action !== 'seeking') delete expected[key];
        return true;
    }

    function sendVideo(currentVideo, action, snapshot = false) {
        if (isExpectedMediaEvent(currentVideo, action)) return;

        const now = Date.now();
        const isSeeking = action === 'seeking';

        // Limit frequent seek and playback-clock messages on busy players.
        if (isSeeking && now - lastTimeSent < 120) return;
        if (action === 'time' && now - lastTimeSent < 700) return;

        lastTimeSent = now;
        chrome.runtime
            .sendMessage({
                type: 'VIDEO_OUT',
                videoState: videoState(currentVideo, isSeeking ? 'seek' : action),
                snapshot,
            })
            .catch(() => {});
    }

    function bind(currentVideo) {
        if (!currentVideo || currentVideo === video) return;

        video = currentVideo;

        for (const eventName of ['play', 'pause', 'seeked', 'ratechange']) {
            video.addEventListener(
                eventName,
                () => sendVideo(currentVideo, eventName),
                { passive: true },
            );
        }

        currentVideo.addEventListener(
            'seeking',
            () => sendVideo(currentVideo, 'seeking'),
            { passive: true },
        );
        currentVideo.addEventListener(
            'timeupdate',
            () => sendVideo(currentVideo, currentVideo.seeking ? 'seeking' : 'time'),
            { passive: true },
        );
    }

    async function applyVideo(remoteState) {
        const currentVideo = chooseVideo();
        if (!remoteState || !currentVideo) return;

        bind(currentVideo);

        // Estimate the current playback point using the sender's timestamp.
        const elapsed = remoteState.paused
            ? 0
            : Math.min(Math.max(0, (Date.now() - remoteState.at) / 1000), 1.5);
        const targetTime = (remoteState.time || 0) + elapsed;

        if (Math.abs(targetTime - currentVideo.currentTime) > 0.8) {
            const seekTo = Math.max(0, targetTime);
            expectMediaEvent(currentVideo, 'time', seekTo);
            currentVideo.currentTime = seekTo;
        }

        if (
            remoteState.rate &&
            Math.abs(currentVideo.playbackRate - remoteState.rate) > 0.03
        ) {
            expectMediaEvent(currentVideo, 'rate', remoteState.rate);
            currentVideo.playbackRate = remoteState.rate;
        }

        if (remoteState.paused) {
            if (!currentVideo.paused) {
                expectMediaEvent(currentVideo, 'paused', true);
                currentVideo.pause();
            }
        } else if (currentVideo.paused) {
            expectMediaEvent(currentVideo, 'paused', false);
            await currentVideo.play().catch(() => {});
        }
    }

    function applyAutomaticPause(message) {
        const currentVideo = chooseVideo();
        if (!currentVideo || !message.navigationId) return;

        // Ignore duplicate relays and replace an older pending resume timer.
        if (!message.pauseId || lastAutoPauseId === message.pauseId) return;
        lastAutoPauseId = message.pauseId;
        clearTimeout(autoPauseTimer);

        bind(currentVideo);
        expectMediaEvent(currentVideo, 'paused', true);
        currentVideo.pause();

        if (typeof message.resumeAt !== 'number') return;

        autoPauseTimer = setTimeout(() => {
            if (
                !currentVideo.paused ||
                (message.url && location.href !== message.url)
            ) {
                return;
            }

            expectMediaEvent(currentVideo, 'paused', false);
            currentVideo.play().catch(() => {});
        }, Math.max(0, message.resumeAt - Date.now()));
    }

    function updateTabTitle() {
        if (!isTop) return;

        const currentTitle = document.title || location.hostname;

        if (tabMarkerEnabled) {
            if (currentTitle === decoratedPageTitle) return;

            const pageTitle = currentTitle.startsWith(tabTitlePrefix)
                ? currentTitle.slice(tabTitlePrefix.length)
                : currentTitle;
            originalPageTitle = pageTitle;
            decoratedPageTitle = tabTitlePrefix + pageTitle;

            if (currentTitle !== decoratedPageTitle) {
                document.title = decoratedPageTitle;
            }
            return;
        }

        if (decoratedPageTitle && currentTitle.startsWith(tabTitlePrefix)) {
            document.title = currentTitle === decoratedPageTitle
                ? originalPageTitle
                : currentTitle.slice(tabTitlePrefix.length);
        }

        decoratedPageTitle = '';
    }

    function updateTabIcon() {
        if (!isTop || !document.head) return;

        const existingIcon = document.getElementById(tabIconId);
        if (!tabIconEnabled) {
            existingIcon?.remove();
            return;
        }

        if (existingIcon) return;

        const icon = document.createElement('link');
        icon.id = tabIconId;
        icon.rel = 'icon';
        icon.type = 'image/svg+xml';
        icon.href = chrome.runtime.getURL('tab-icon.svg');
        document.head.append(icon);
    }

    function updateTabMarker(enabled, modifyIcon) {
        if (!isTop) return;

        tabMarkerEnabled = !!enabled;
        tabIconEnabled = tabMarkerEnabled && !!modifyIcon;
        updateTabTitle();
        updateTabIcon();

        if (tabMarkerEnabled) {
            if (!tabMarkerObserver && document.head) {
                tabMarkerObserver = new MutationObserver(() => {
                    updateTabTitle();
                    updateTabIcon();
                });
                tabMarkerObserver.observe(document.head, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                });
            }
            return;
        }

        tabMarkerObserver?.disconnect();
        tabMarkerObserver = null;
    }

    function showPrompt(kind, data) {
        if (!isTop) return;

        document.getElementById('__sync_watch_prompt')?.remove();

        const isHostPrompt = kind === 'host';
        const root = document.createElement('div');
        root.id = '__sync_watch_prompt';
        root.style.cssText =
            'position:fixed;z-index:2147483647;top:18px;right:18px;width:min(390px,calc(100vw - 36px));padding:15px;background:#151827;color:#f4f5fb;border:1px solid #6f62db;border-radius:12px;box-shadow:0 12px 38px #0008;font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';

        const title = document.createElement('strong');
        title.textContent = isHostPrompt ? '分享新视频？' : '主机分享了新视频';
        title.style.cssText = 'display:block;font-size:15px;margin-bottom:5px';

        const description = document.createElement('div');
        description.textContent = data.title || data.url || '新视频';
        description.style.cssText =
            'color:#b8bfd1;overflow-wrap:anywhere;margin-bottom:12px';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

        function addButton(label, primary, onClick) {
            const button = document.createElement('button');
            button.textContent = label;
            button.style.cssText = `border:0;border-radius:8px;padding:8px 12px;background:${primary ? '#7666f4' : '#2a3040'};color:#fff;font-weight:600;cursor:pointer`;
            button.onclick = onClick;
            actions.append(button);
        }

        if (isHostPrompt) {
            addButton('暂不分享', false, () => {
                chrome.runtime.sendMessage({ type: 'DECLINE_SHARE' });
                root.remove();
            });
            addButton('分享给房间', true, () => {
                chrome.runtime.sendMessage({ type: 'SHARE_PAGE' });
                root.remove();
            });
        } else {
            addButton('不跟随', false, () => {
                chrome.runtime.sendMessage({
                    type: 'FOLLOW_DECISION',
                    follow: false,
                });
                root.remove();
            });
            addButton('跟随跳转', true, () => {
                chrome.runtime.sendMessage({
                    type: 'FOLLOW_DECISION',
                    follow: true,
                });
                root.remove();
            });
        }

        root.append(title, description, actions);
        document.documentElement.append(root);
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'APPLY_REMOTE_VIDEO') {
            applyVideo(message.videoState);
        } else if (message.type === 'AUTO_PAUSE') {
            applyAutomaticPause(message);
        } else if (message.type === 'SET_TAB_MARKER') {
            updateTabMarker(message.enabled, message.modifyIcon);
        } else if (message.type === 'SHOW_HOST_PROMPT') {
            showPrompt('host', message);
        } else if (message.type === 'HIDE_ROOM_PROMPT') {
            document.getElementById('__sync_watch_prompt')?.remove();
        } else if (message.type === 'GET_VIDEO_SNAPSHOT') {
            const currentVideo = chooseVideo();
            if (currentVideo) sendVideo(currentVideo, 'snapshot', true);
        } else if (message.type === 'ROOM_CONNECTED') {
            role = message.role || '';
        }
    });

    if (isTop) chrome.runtime.sendMessage({ type: 'GET_ROLE' });

    function reportVideoFrame() {
        const currentVideo = chooseVideo();
        if (currentVideo !== video) bind(currentVideo);

        let score = 0;
        if (currentVideo) {
            const rect = currentVideo.getBoundingClientRect();
            const style = getComputedStyle(currentVideo);
            const isVisible =
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden';

            if (isVisible) score = Math.round(rect.width * rect.height);
        }

        const key = `${location.href}:${video ? `${score}:${video.readyState}:${video.videoWidth}x${video.videoHeight}` : 'none'}`;
        if (key === lastFrameReport) return;

        lastFrameReport = key;
        chrome.runtime
            .sendMessage({
                type: 'VIDEO_FRAME',
                hasVideo: !!video && video.readyState > 0,
                score,
                pageUrl: location.href,
                title: document.title,
            })
            .catch(() => {});
    }

    // Watch for players inserted after the page's initial load, including SPA navigation.
    bind(chooseVideo());
    reportVideoFrame();
    new MutationObserver(() => {
        bind(chooseVideo());
        reportVideoFrame();
    }).observe(document.documentElement, { childList: true, subtree: true });

    for (const eventName of ['popstate', 'hashchange']) {
        window.addEventListener(eventName, reportVideoFrame);
    }

    setInterval(() => {
        if (!video || !video.isConnected) bind(chooseVideo());
        reportVideoFrame();
    }, 2500);
})();
