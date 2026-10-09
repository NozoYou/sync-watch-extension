// The service worker owns room state and keeps the signaling socket alive
// while users move between video tabs.
let socket = null;
let pingTimer = null;
let reconnectTimer = null;

const videoFrames = new Map();
const navigationNotificationPrefix = 'sync-watch-navigation-';

const state = {
    server: '',
    turnUrls: '',
    turnUsername: '',
    turnCredential: '',
    room: '',
    role: '',
    modifyTabIcon: false,
    status: '打开视频页面后创建房间，或输入房间码加入。',
    connected: false,
    memberCount: 0,
    roomLimit: 4,
    dataConnections: 0,
    tabId: null,
    videoFrameId: 0,
    videoReady: false,
    clientId: '',
    hostClientId: '',
    members: [],
    memberSettings: {},
    navigationHistory: [],
    autoPause: { enabled: false, duration: 5 },
    autoPauseReady: [],
    autoPauseStartedNavigationId: '',
    currentVideoUrl: '',
    pendingNavigation: null,
    sharedNavigation: null,
    followResponses: [],
    followingHost: true,
    hostCandidate: null,
};

// Restore the previous room after Chrome suspends and wakes the service worker.
const ready = chrome.storage.local
    .get([
        'server',
        'turnUrls',
        'turnUsername',
        'turnCredential',
        'room',
        'role',
        'modifyTabIcon',
        'tabId',
        'videoFrameId',
        'videoReady',
        'clientId',
        'hostClientId',
        'members',
        'memberSettings',
        'navigationHistory',
        'autoPause',
        'autoPauseReady',
        'autoPauseStartedNavigationId',
        'currentVideoUrl',
        'pendingNavigation',
        'sharedNavigation',
        'followResponses',
        'followingHost',
    ])
    .then((saved) => {
        Object.assign(state, saved);

        if (state.room) {
            state.connected = false;
            setTabMarker(state.tabId, true);
            setTimeout(() => connectRoom(), 100);
        }
    });

function persist() {
    chrome.storage.local.set({
        server: state.server,
        turnUrls: state.turnUrls,
        turnUsername: state.turnUsername,
        turnCredential: state.turnCredential,
        room: state.room,
        role: state.role,
        modifyTabIcon: state.modifyTabIcon,
        status: state.status,
        connected: state.connected,
        memberCount: state.memberCount,
        roomLimit: state.roomLimit,
        dataConnections: state.dataConnections,
        tabId: state.tabId,
        videoFrameId: state.videoFrameId,
        videoReady: state.videoReady,
        clientId: state.clientId,
        hostClientId: state.hostClientId,
        members: state.members,
        memberSettings: state.memberSettings,
        navigationHistory: state.navigationHistory,
        autoPause: state.autoPause,
        autoPauseReady: state.autoPauseReady,
        autoPauseStartedNavigationId: state.autoPauseStartedNavigationId,
        currentVideoUrl: state.currentVideoUrl,
        pendingNavigation: state.pendingNavigation,
        sharedNavigation: state.sharedNavigation,
        followResponses: state.followResponses,
        followingHost: state.followingHost,
    });
}

// Keep the popup synchronized with changes made by the service worker.
function publish() {
    persist();
    chrome.runtime.sendMessage({ type: 'STATE', state }).catch(() => {});
}

function setStatus(status) {
    state.status = status;
    publish();
}

function defaultMemberSettings() {
    return {
        canControlPlayback: true,
        canSeek: true,
        autoFollow: false,
    };
}

function getMemberSettings(clientId) {
    if (!state.memberSettings[clientId]) {
        state.memberSettings[clientId] = defaultMemberSettings();
    }

    return state.memberSettings[clientId];
}

function canSendPlaybackAction(settings, action) {
    if (action === 'play' || action === 'pause') {
        return settings.canControlPlayback;
    }

    if (action === 'seek' || action === 'seeked') {
        return settings.canSeek;
    }

    return true;
}

function mergeRoomMemberSettings(memberSettings = {}) {
    state.memberSettings = {
        ...state.memberSettings,
        ...memberSettings,
    };

    for (const clientId of state.members) {
        state.memberSettings[clientId] = {
            ...defaultMemberSettings(),
            ...state.memberSettings[clientId],
        };
    }
}

function sendTab(message, frameId = 0, tabId = state.tabId) {
    if (tabId === null || tabId === undefined) return;

    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {});
}

function setTabMarker(tabId, enabled) {
    if (tabId === null || tabId === undefined) return;

    sendTab(
        {
            type: 'SET_TAB_MARKER',
            enabled: !!enabled,
            modifyIcon: !!enabled && state.modifyTabIcon,
        },
        0,
        tabId,
    );
}

function switchRoomTab(tabId) {
    const previousTabId = state.tabId;

    if (previousTabId !== null && previousTabId !== tabId) {
        setTabMarker(previousTabId, false);
    }

    state.tabId = tabId ?? null;

    if (state.room && state.tabId !== null) {
        setTabMarker(state.tabId, true);
    }
}

function sendRoomEvent(event, payload) {
    if (socket?.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({ type: 'room-event', event, payload }));
}

function addNavigationToHistory(navigation) {
    if (
        !navigation?.id ||
        state.navigationHistory.some((item) => item.id === navigation.id)
    ) {
        return;
    }

    state.navigationHistory = [navigation, ...state.navigationHistory].slice(0, 15);
}

function mergeNavigationHistory(history = []) {
    const seen = new Set();
    state.navigationHistory = [...history, ...state.navigationHistory]
        .filter((item) => {
            if (!item?.id || !safePageUrl(item.url) || seen.has(item.id)) {
                return false;
            }

            seen.add(item.id);
            return true;
        })
        .slice(0, 15);
}

function announceNavigationReady() {
    if (
        !state.connected ||
        !state.sharedNavigation?.id ||
        !state.videoReady ||
        state.currentVideoUrl !== state.sharedNavigation.url ||
        state.followingHost !== true
    ) {
        return;
    }

    if (!state.autoPauseReady.includes(state.clientId)) {
        state.autoPauseReady.push(state.clientId);
        sendRoomEvent('auto-pause-ready', {
            navigationId: state.sharedNavigation.id,
        });
    }

    if (state.role === 'host') startAutoPauseWhenReady();
}

function startAutoPauseWhenReady() {
    if (
        state.role !== 'host' ||
        !state.autoPause.enabled ||
        !state.sharedNavigation?.id ||
        !state.autoPauseReady.includes(state.clientId) ||
        state.autoPauseStartedNavigationId === state.sharedNavigation.id
    ) {
        return;
    }

    const followingMembers = state.followResponses
        .filter((response) => response.status === 'following')
        .map((response) => response.clientId);

    if (followingMembers.some((clientId) => !state.autoPauseReady.includes(clientId))) {
        return;
    }

    // A common resume time keeps every ready player paused for the same interval.
    const duration = state.autoPause.duration;
    const resumeAt =
        duration === 'manual' ? null : Date.now() + Number(duration) * 1000;
    const payload = {
        navigationId: state.sharedNavigation.id,
        pauseId: crypto.randomUUID(),
        url: state.sharedNavigation.url,
        resumeAt,
    };

    state.autoPauseStartedNavigationId = state.sharedNavigation.id;
    publish();
    sendTab({ type: 'AUTO_PAUSE', ...payload }, state.videoFrameId);
    sendRoomEvent('auto-pause-start', payload);
}

function safePageUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

function bestVideoFrame(tabId) {
    return (
        [...videoFrames.values()]
            .filter((frame) => frame.tabId === tabId && frame.hasVideo)
            .sort((a, b) => b.score - a.score)[0] || null
    );
}

function selectVideoFrame(tabId) {
    const frame = bestVideoFrame(tabId);
    state.videoFrameId = frame?.frameId ?? 0;
    return frame;
}

function disconnectSocket() {
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);

    if (!socket) return;

    // Prevent an intentional close from triggering the reconnect handler.
    socket.onclose = null;
    socket.close();
    socket = null;
}

function notifyNavigation(navigation) {
    if (!navigation?.id || !chrome.notifications) return;

    const notificationId = navigationNotificationPrefix + navigation.id;

    chrome.action.setBadgeBackgroundColor({ color: '#7666f4' }).catch(() => {});
    chrome.action.setBadgeText({ text: '!' }).catch(() => {});
    chrome.notifications
        .create(notificationId, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('notification-icon.png'),
            title: '房主分享了新视频',
            message: String(navigation.title || '新视频').slice(0, 160),
            priority: 0,
        })
        .catch(() => {});
}

function clearNavigationNotification(navigationId) {
    if (navigationId && chrome.notifications) {
        chrome.notifications
            .clear(navigationNotificationPrefix + navigationId)
            .catch(() => {});
    }

    chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

// Clicking the notification opens the popup where the URL and follow controls live.
chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(navigationNotificationPrefix)) return;

    chrome.notifications.clear(notificationId).catch(() => {});

    if (chrome.action.openPopup) {
        chrome.action
            .openPopup()
            .catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }));
        return;
    }

    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

async function connectRoom() {
    await ready;
    disconnectSocket();

    if (!state.server || !state.room) {
        setStatus('请填写服务器地址和房间码。');
        return;
    }

    try {
        socket = new WebSocket(state.server);
    } catch (error) {
        setStatus('服务器地址无效：' + error.message);
        return;
    }

    socket.onopen = () => {
        // Keep one ID across reconnects so the room can restore this member's settings.
        state.clientId ||= crypto.randomUUID();
        socket.send(
            JSON.stringify({
                type: 'join',
                room: state.room,
                clientId: state.clientId,
                role: state.role,
            }),
        );

        setStatus('正在连接房间…');
        pingTimer = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 20_000);
    };

    socket.onmessage = (event) => {
        let message;

        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }

        if (message.type === 'joined') {
            state.clientId = message.clientId;
            state.connected = true;
            state.roomLimit = message.limit || 4;
            state.members = [...(message.peers || []), message.clientId];
            state.memberCount = state.members.length;
            state.hostClientId =
                message.hostClientId ||
                (state.role === 'host'
                    ? message.clientId
                    : (message.peers || [])[0] || message.clientId);
            mergeRoomMemberSettings(message.memberSettings);
            const locallySavedHistory = state.navigationHistory;
            state.navigationHistory = [];
            mergeNavigationHistory([
                ...locallySavedHistory,
                ...(message.navigationHistory || []),
            ]);
            state.autoPause = message.autoPause || { enabled: false, duration: 5 };
            state.autoPauseReady = [];

            if (state.role === 'host') {
                if (message.sharedNavigation) {
                    addNavigationToHistory(message.sharedNavigation);
                }

                // Restore a locally shared page if it was created while the server was offline.
                if (
                    state.sharedNavigation &&
                    state.sharedNavigation.id !== message.sharedNavigation?.id
                ) {
                    addNavigationToHistory(state.sharedNavigation);
                    sendRoomEvent('navigate', state.sharedNavigation);
                } else if (message.sharedNavigation) {
                    state.sharedNavigation = message.sharedNavigation;
                }

                if (state.navigationHistory.length) {
                    sendRoomEvent('history-sync', {
                        history: state.navigationHistory,
                    });
                }
            }

            if (state.role !== 'host') state.followingHost = true;

            setStatus('房间连接已建立。');

            if (state.tabId !== null) {
                sendTab({ type: 'ROOM_CONNECTED', role: state.role });
                setTabMarker(state.tabId, true);
            }

            if (state.role !== 'host' && message.sharedNavigation) {
                state.sharedNavigation = message.sharedNavigation;
                addNavigationToHistory(message.sharedNavigation);

                if (state.currentVideoUrl === message.sharedNavigation.url) {
                    state.followingHost = true;
                    sendRoomEvent('snapshot-request', {
                        navigationId: message.sharedNavigation.id,
                    });
                    sendRoomEvent('follow-response', {
                        navigationId: message.sharedNavigation.id,
                        status: 'following',
                    });
                } else if (getMemberSettings(state.clientId).autoFollow) {
                    state.pendingNavigation = message.sharedNavigation;
                    chooseNavigation(true, message.sharedNavigation);
                } else {
                    state.pendingNavigation = message.sharedNavigation;
                    state.followingHost = null;
                    notifyNavigation(message.sharedNavigation);
                }
            } else if (state.role !== 'host') {
                sendRoomEvent('snapshot-request', { navigationId: '' });
            }

            announceNavigationReady();
            publish();
            return;
        }

        if (message.type === 'peer-joined') {
            if (!state.members.includes(message.clientId)) {
                state.members.push(message.clientId);
            }

            getMemberSettings(message.clientId);
            state.memberCount = state.members.length;

            if (state.sharedNavigation) {
                state.followResponses.push({
                    clientId: message.clientId,
                    status: 'pending',
                });
            }

            publish();
            return;
        }

        if (message.type === 'host-changed') {
            state.hostClientId = message.hostClientId || '';
            publish();
            return;
        }

        if (message.type === 'peer-left') {
            state.members = state.members.filter((id) => id !== message.clientId);
            state.memberCount = state.members.length;
            state.followResponses = state.followResponses.filter(
                (response) => response.clientId !== message.clientId,
            );
            state.autoPauseReady = state.autoPauseReady.filter(
                (clientId) => clientId !== message.clientId,
            );
            startAutoPauseWhenReady();
            publish();
            return;
        }

        if (message.type === 'signal') return;
        if (message.type === 'room-event') handleRoomEvent(message);
        if (message.type === 'error') setStatus(message.message || '服务器错误');
    };

    socket.onclose = () => {
        state.connected = false;

        if (state.room) {
            setStatus('服务器断开，正在重连…');
            reconnectTimer = setTimeout(() => connectRoom(), 3000);
        }
    };

    socket.onerror = () => setStatus('连接服务器失败；请检查地址和网络。');
    publish();
}

function handleRoomEvent(message) {
    if (message.event === 'history-sync' && message.from === state.hostClientId) {
        mergeNavigationHistory(message.payload?.history || []);
        publish();
        return;
    }

    if (message.event === 'room-settings' && message.from === state.hostClientId) {
        state.autoPause = {
            enabled: !!message.payload?.autoPause?.enabled,
            duration: message.payload?.autoPause?.duration || 5,
        };
        publish();
        return;
    }

    if (
        message.event === 'auto-pause-ready' &&
        state.role === 'host' &&
        message.payload?.navigationId === state.sharedNavigation?.id &&
        state.members.includes(message.from)
    ) {
        if (!state.autoPauseReady.includes(message.from)) {
            state.autoPauseReady.push(message.from);
        }
        startAutoPauseWhenReady();
        publish();
        return;
    }

    if (
        message.event === 'auto-pause-start' &&
        state.role !== 'host' &&
        message.payload?.navigationId === state.sharedNavigation?.id &&
        state.followingHost === true
    ) {
        sendTab(
            { type: 'AUTO_PAUSE', ...message.payload },
            state.videoFrameId,
        );
        state.autoPauseStartedNavigationId = message.payload.navigationId;
        publish();
        return;
    }

    if (message.event === 'member-settings') {
        const targetClientId = message.payload?.targetClientId;
        const updates = message.payload?.settings || {};
        const isHostUpdate = message.from === state.hostClientId;
        const isOwnAutoFollowUpdate =
            message.from === targetClientId &&
            (targetClientId === state.clientId || state.role === 'host');

        // The host may edit any member. A member may only update their own auto-follow option.
        if (!targetClientId || (!isHostUpdate && !isOwnAutoFollowUpdate)) return;

        const allowedKeys = isHostUpdate
            ? ['canControlPlayback', 'canSeek', 'autoFollow']
            : ['autoFollow'];
        const currentSettings = getMemberSettings(targetClientId);

        for (const key of allowedKeys) {
            if (typeof updates[key] === 'boolean') {
                currentSettings[key] = updates[key];
            }
        }

        if (
            targetClientId === state.clientId &&
            updates.autoFollow === true &&
            state.pendingNavigation
        ) {
            void chooseNavigation(true, state.pendingNavigation);
            return;
        }

        publish();
        return;
    }

    if (
        message.event === 'navigate' &&
        message.from === state.hostClientId &&
        state.role !== 'host'
    ) {
        if (!safePageUrl(message.payload?.url)) return;

        state.pendingNavigation = message.payload;
        state.sharedNavigation = message.payload;
        addNavigationToHistory(message.payload);
        state.autoPauseReady = [];
        state.autoPauseStartedNavigationId = '';
        state.followResponses = state.members
            .filter((clientId) => clientId !== state.hostClientId)
            .map((clientId) => ({ clientId, status: 'pending' }));

        if (getMemberSettings(state.clientId).autoFollow) {
            void chooseNavigation(true, message.payload);
            return;
        }

        state.followingHost = null;

        publish();
        notifyNavigation(message.payload);
        return;
    }

    if (
        message.event === 'follow-response' &&
        message.payload?.navigationId === state.sharedNavigation?.id
    ) {
        const response = state.followResponses.find(
            (item) => item.clientId === message.from,
        );

        if (response) {
            response.status = message.payload.status;
        } else {
            state.followResponses.push({
                clientId: message.from,
                status: message.payload.status,
            });
        }

        // If someone opts in after an earlier group pause, include them in a new pause cycle.
        if (
            message.payload.status === 'following' &&
            !state.autoPauseReady.includes(message.from)
        ) {
            state.autoPauseStartedNavigationId = '';
            startAutoPauseWhenReady();
        }

        publish();
        return;
    }

    if (
        message.event === 'snapshot-request' &&
        state.role === 'host' &&
        (!message.payload?.navigationId ||
            message.payload.navigationId === state.sharedNavigation?.id)
    ) {
        sendTab({ type: 'GET_VIDEO_SNAPSHOT' }, state.videoFrameId);
        return;
    }

    if (
        (message.event === 'video' || message.event === 'snapshot') &&
        message.from !== state.clientId
    ) {
        if (state.role !== 'host' && state.followingHost !== true) return;

        if (state.role === 'host') {
            const response = state.followResponses.find(
                (item) => item.clientId === message.from,
            );

            if (response && response.status !== 'following') return;

            const memberSettings = getMemberSettings(message.from);
            if (!canSendPlaybackAction(memberSettings, message.payload?.action)) {
                return;
            }
        }

        if (state.videoReady && state.tabId !== null) {
            sendTab(
                { type: 'APPLY_REMOTE_VIDEO', videoState: message.payload },
                state.videoFrameId,
            );
        }
    }
}

async function chooseNavigation(shouldFollow, navigation) {
    const responseStatus = shouldFollow ? 'following' : 'not-following';

    clearNavigationNotification(navigation.id);
    state.pendingNavigation = null;
    state.followingHost = !!shouldFollow;
    state.status = shouldFollow
        ? '正在跟随主机，视频页加载后会自动同步。'
        : '已选择不跟随主机。';
    state.followResponses = state.followResponses.filter(
        (response) => response.clientId !== state.clientId,
    );
    state.followResponses.push({
        clientId: state.clientId,
        status: responseStatus,
    });

    if (shouldFollow) {
        state.currentVideoUrl = navigation.url;
        state.videoReady = false;

        let tabExists = false;
        if (state.tabId !== null) {
            try {
                await chrome.tabs.get(state.tabId);
                tabExists = true;
            } catch {
                // The old video tab may have been closed; open a new one below.
            }
        }

        if (tabExists) {
            chrome.tabs.update(state.tabId, { url: navigation.url });
        } else {
            chrome.tabs.create({ url: navigation.url }, (tab) => {
                switchRoomTab(tab.id);
                publish();
            });
        }
    }

    publish();
    sendRoomEvent('follow-response', {
        navigationId: navigation.id,
        status: responseStatus,
    });
}

function hostPageDetected(tabId, candidate) {
    if (state.role !== 'host' || !state.room || !candidate?.hasVideo) return;

    const pageUrl = safePageUrl(candidate.pageUrl);
    if (!pageUrl) return;

    if (!state.currentVideoUrl) {
        state.currentVideoUrl = pageUrl;
        switchRoomTab(tabId);
        state.videoFrameId = candidate.frameId;
        state.videoReady = true;

        if (!state.sharedNavigation) {
            state.sharedNavigation = {
                id: crypto.randomUUID(),
                url: pageUrl,
                title: candidate.title || '当前视频',
            };
            addNavigationToHistory(state.sharedNavigation);

            if (state.connected) {
                sendRoomEvent('navigate', state.sharedNavigation);
            }
        }

        publish();
        return;
    }

    if (pageUrl === state.currentVideoUrl) {
        if (
            state.tabId !== tabId ||
            state.videoFrameId !== candidate.frameId ||
            !state.videoReady
        ) {
            switchRoomTab(tabId);
            state.videoFrameId = candidate.frameId;
            state.videoReady = true;
            publish();
        }

        // A room created before the video frame was detected still shares its first page.
        if (!state.sharedNavigation) {
            state.sharedNavigation = {
                id: crypto.randomUUID(),
                url: pageUrl,
                title: candidate.title || '当前视频',
            };
            addNavigationToHistory(state.sharedNavigation);
            publish();
            if (state.connected) {
                sendRoomEvent('navigate', state.sharedNavigation);
            }
        }
        announceNavigationReady();
        return;
    }

    const key = `${tabId}:${pageUrl}`;
    if (state.hostCandidate?.key === key) return;

    state.videoReady = false;
    state.hostCandidate = {
        key,
        tabId,
        frameId: candidate.frameId,
        url: pageUrl,
        title: candidate.title || '新视频',
    };

    publish();
    sendTab(
        {
            type: 'SHOW_HOST_PROMPT',
            url: pageUrl,
            title: candidate.title || '新视频',
        },
        0,
        tabId,
    );
}

async function inspectActiveTab(tabId) {
    if (state.role !== 'host' || !state.room) return;

    const candidate = bestVideoFrame(tabId);
    if (candidate) hostPageDetected(tabId, candidate);
}

chrome.runtime.onMessage.addListener((message, sender) => {
    ready.then(async () => {
        if (message.type === 'VIDEO_FRAME' && sender.tab?.id !== undefined) {
            const tabId = sender.tab.id;
            const frameId = sender.frameId || 0;
            const key = `${tabId}:${frameId}`;
            const candidate = {
                tabId,
                frameId,
                hasVideo: !!message.hasVideo,
                score: message.score || 0,
                pageUrl: sender.tab.url || message.pageUrl || '',
                title: sender.tab.title || message.title || '新视频',
            };

            videoFrames.set(key, candidate);

            if (tabId === state.tabId) {
                setTabMarker(tabId, true);
                const wasReady = state.videoReady;
                const selected = selectVideoFrame(tabId);

                if (
                    selected &&
                    state.role === 'host' &&
                    selected.pageUrl === state.currentVideoUrl
                ) {
                    state.videoReady = true;
                } else if (
                    selected &&
                    state.role !== 'host' &&
                    state.followingHost === true &&
                    state.pendingNavigation === null
                ) {
                    state.currentVideoUrl = selected.pageUrl;
                    state.videoReady = true;

                    if (!wasReady && state.sharedNavigation) {
                        sendRoomEvent('snapshot-request', {
                            navigationId: state.sharedNavigation.id,
                        });
                    }
                }

                announceNavigationReady();
            }

            if (sender.tab.active && candidate.hasVideo) {
                hostPageDetected(tabId, candidate);
            }

            publish();
            return;
        }

        if (
            message.type === 'VIDEO_OUT' &&
            sender.tab?.id === state.tabId &&
            (sender.frameId || 0) === state.videoFrameId
        ) {
            if (
                !state.room ||
                !state.connected ||
                (state.role !== 'host' && state.followingHost !== true) ||
                (state.role === 'host' && !state.videoReady)
            ) {
                return;
            }

            const action = message.videoState?.action;
            const ownSettings = getMemberSettings(state.clientId);

            if (
                state.role !== 'host' &&
                !message.snapshot &&
                !canSendPlaybackAction(ownSettings, action)
            ) {
                return;
            }

            // Followers send control actions, but their periodic clock samples and
            // in-progress seek samples can fight the host's own playback state.
            if (
                state.role !== 'host' &&
                !message.snapshot &&
                ['time', 'seek'].includes(message.videoState?.action)
            ) {
                return;
            }

            sendRoomEvent(
                message.snapshot ? 'snapshot' : 'video',
                message.videoState,
            );
            return;
        }

        if (
            message.type === 'SHARE_PAGE' &&
            state.role === 'host' &&
            state.hostCandidate &&
            sender.tab?.id === state.hostCandidate.tabId
        ) {
            const candidate = state.hostCandidate;
            const selected = bestVideoFrame(candidate.tabId);
            const url = safePageUrl(candidate.url);
            if (!url) return;

            switchRoomTab(candidate.tabId);
            state.videoFrameId = selected?.frameId ?? candidate.frameId;
            state.videoReady = true;
            state.currentVideoUrl = url;
            state.sharedNavigation = {
                id: crypto.randomUUID(),
                url,
                title: candidate.title,
            };
            addNavigationToHistory(state.sharedNavigation);
            state.autoPauseReady = [state.clientId];
            state.autoPauseStartedNavigationId = '';
            state.hostCandidate = null;
            state.followResponses = state.members
                .filter((clientId) => clientId !== state.clientId)
                .map((clientId) => ({ clientId, status: 'pending' }));
            state.status = '已分享新视频，等待成员选择是否跟随。';

            publish();
            sendRoomEvent('navigate', state.sharedNavigation);
            startAutoPauseWhenReady();
            sendTab({ type: 'GET_VIDEO_SNAPSHOT' }, state.videoFrameId);
            return;
        }

        if (
            message.type === 'DECLINE_SHARE' &&
            state.hostCandidate &&
            sender.tab?.id === state.hostCandidate.tabId
        ) {
            setTabMarker(state.tabId, false);
            state.tabId = state.hostCandidate.tabId;
            setTabMarker(state.tabId, false);
            state.videoFrameId = state.hostCandidate.frameId;
            state.videoReady = false;
            state.hostCandidate = null;
            setStatus('本页未分享给房间。');
            return;
        }

        if (message.type === 'FOLLOW_DECISION' && state.pendingNavigation) {
            const navigation = state.pendingNavigation;
            await chooseNavigation(message.follow, navigation);
            return;
        }

        if (
            message.type === 'SET_AUTO_FOLLOW' &&
            state.role !== 'host' &&
            state.connected &&
            state.clientId
        ) {
            const settings = getMemberSettings(state.clientId);
            settings.autoFollow = !!message.enabled;

            if (settings.autoFollow && state.pendingNavigation) {
                void chooseNavigation(true, state.pendingNavigation);
            } else {
                publish();
            }

            sendRoomEvent('member-settings', {
                targetClientId: state.clientId,
                settings: { autoFollow: settings.autoFollow },
            });
            return;
        }

        if (
            message.type === 'UPDATE_MEMBER_SETTINGS' &&
            state.role === 'host' &&
            state.connected
        ) {
            const { targetClientId, key, value } = message;
            const allowedKeys = [
                'canControlPlayback',
                'canSeek',
                'autoFollow',
            ];

            if (
                !state.members.includes(targetClientId) ||
                targetClientId === state.clientId ||
                !allowedKeys.includes(key)
            ) {
                return;
            }

            const settings = getMemberSettings(targetClientId);
            settings[key] = !!value;

            publish();
            sendRoomEvent('member-settings', {
                targetClientId,
                settings: { [key]: settings[key] },
            });
            return;
        }

        if (
            message.type === 'SET_AUTO_PAUSE' &&
            state.role === 'host' &&
            state.connected
        ) {
            const requestedDuration =
                message.duration === 'manual'
                    ? 'manual'
                    : Number(message.duration);
            const duration = [3, 5, 10].includes(requestedDuration)
                ? requestedDuration
                : requestedDuration === 'manual'
                  ? 'manual'
                  : 5;
            state.autoPause = {
                enabled: !!message.enabled,
                duration,
            };
            publish();
            sendRoomEvent('room-settings', { autoPause: state.autoPause });
            return;
        }

        if (message.type === 'SET_TAB_ICON') {
            state.modifyTabIcon = !!message.enabled;
            publish();
            setTabMarker(state.tabId, !!state.room);
            return;
        }

        if (message.type === 'SAVE_CONFIG') {
            state.server = message.server;
            state.turnUrls = message.turnUrls || '';
            state.turnUsername = message.turnUsername || '';
            state.turnCredential = message.turnCredential || '';
            publish();
            return;
        }

        if (message.type === 'CREATE_ROOM') {
            state.server = message.server || state.server;
            state.room = Math.random().toString(36).slice(2, 8).toUpperCase();
            state.role = 'host';
            switchRoomTab(message.tabId);

            const tab = await chrome.tabs.get(message.tabId).catch(() => null);
            state.currentVideoUrl = safePageUrl(tab?.url) || '';

            const frame = selectVideoFrame(state.tabId);
            state.videoReady = !!frame;
            state.clientId = '';
            state.hostClientId = '';
            state.members = [];
            state.memberSettings = {};
            state.navigationHistory = [];
            state.autoPause = { enabled: false, duration: 5 };
            state.autoPauseReady = [];
            state.autoPauseStartedNavigationId = '';
            state.memberCount = 0;
            state.dataConnections = 0;
            state.pendingNavigation = null;
            state.sharedNavigation = null;
            const initialVideo = bestVideoFrame(state.tabId);
            if (initialVideo) {
                const initialUrl = safePageUrl(initialVideo.pageUrl || tab?.url);
                if (initialUrl) {
                    state.sharedNavigation = {
                        id: crypto.randomUUID(),
                        url: initialUrl,
                        title: initialVideo.title || tab?.title || '当前视频',
                    };
                    addNavigationToHistory(state.sharedNavigation);
                }
            }
            state.followResponses = [];
            state.followingHost = true;
            state.status = '正在创建房间…';

            publish();
            connectRoom();
            return;
        }

        if (message.type === 'JOIN_ROOM') {
            const roomCode = (message.room || '')
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 12);

            if (!roomCode) {
                setStatus('请输入房间码。');
                return;
            }

            state.server = message.server || state.server;
            state.room = roomCode;
            state.role = 'guest';
            switchRoomTab(message.tabId);

            const tab = await chrome.tabs.get(message.tabId).catch(() => null);
            state.currentVideoUrl = tab?.url || '';

            const frame = selectVideoFrame(state.tabId);
            state.videoReady = !!frame;
            state.clientId = '';
            state.hostClientId = '';
            state.memberCount = 0;
            state.members = [];
            state.memberSettings = {};
            state.navigationHistory = [];
            state.autoPause = { enabled: false, duration: 5 };
            state.autoPauseReady = [];
            state.autoPauseStartedNavigationId = '';
            state.dataConnections = 0;
            state.pendingNavigation = null;
            state.sharedNavigation = null;
            state.followResponses = [];
            state.followingHost = true;

            publish();
            connectRoom();
            return;
        }

        if (message.type === 'LEAVE') {
            setTabMarker(state.tabId, false);
            disconnectSocket();
            sendTab({ type: 'ROOM_STOP' });
            state.room = '';
            state.role = '';
            state.clientId = '';
            state.hostClientId = '';
            state.connected = false;
            state.memberCount = 0;
            state.dataConnections = 0;
            state.members = [];
            state.memberSettings = {};
            state.navigationHistory = [];
            state.autoPause = { enabled: false, duration: 5 };
            state.autoPauseReady = [];
            state.autoPauseStartedNavigationId = '';
            state.pendingNavigation = null;
            state.sharedNavigation = null;
            state.followResponses = [];
            state.hostCandidate = null;
            state.status = '已离开房间。';
            publish();
        }
    });

    // Keep the message channel alive while the asynchronous handler is running.
    return true;
});

// Detect when the host switches to another tab that already contains a video.
chrome.tabs.onActivated.addListener(({ tabId }) => {
    inspectActiveTab(tabId);
});

// Remove stale frame metadata and clear the active video when its tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [key, frame] of videoFrames) {
        if (frame.tabId === tabId) videoFrames.delete(key);
    }

    if (state.tabId === tabId) {
        state.tabId = null;
        state.videoReady = false;
        state.videoFrameId = 0;
        publish();
    }
});
