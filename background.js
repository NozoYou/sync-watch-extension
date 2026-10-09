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
        'tabId',
        'videoFrameId',
        'videoReady',
        'clientId',
        'hostClientId',
        'members',
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

function sendTab(message, frameId = 0, tabId = state.tabId) {
    if (tabId === null || tabId === undefined) return;

    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {});
}

function sendRoomEvent(event, payload) {
    if (socket?.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({ type: 'room-event', event, payload }));
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
        state.clientId = crypto.randomUUID();
        socket.send(
            JSON.stringify({
                type: 'join',
                room: state.room,
                clientId: state.clientId,
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
                state.role === 'host'
                    ? message.clientId
                    : (message.peers || [])[0] || message.clientId;

            if (state.role !== 'host') state.followingHost = true;

            setStatus('房间连接已建立。');

            if (state.tabId !== null) {
                sendTab({ type: 'ROOM_CONNECTED', role: state.role });
            }

            if (state.role !== 'host' && message.sharedNavigation) {
                state.sharedNavigation = message.sharedNavigation;

                if (state.currentVideoUrl === message.sharedNavigation.url) {
                    state.followingHost = true;
                    sendRoomEvent('snapshot-request', {
                        navigationId: message.sharedNavigation.id,
                    });
                } else {
                    state.pendingNavigation = message.sharedNavigation;
                    state.followingHost = null;
                    notifyNavigation(message.sharedNavigation);
                }
            } else if (state.role !== 'host') {
                sendRoomEvent('snapshot-request', { navigationId: '' });
            }

            publish();
            return;
        }

        if (message.type === 'peer-joined') {
            if (!state.members.includes(message.clientId)) {
                state.members.push(message.clientId);
            }

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

        if (message.type === 'peer-left') {
            state.members = state.members.filter((id) => id !== message.clientId);
            state.memberCount = state.members.length;
            state.followResponses = state.followResponses.filter(
                (response) => response.clientId !== message.clientId,
            );
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
    if (
        message.event === 'navigate' &&
        message.from === state.hostClientId &&
        state.role !== 'host'
    ) {
        if (!safePageUrl(message.payload?.url)) return;

        state.pendingNavigation = message.payload;
        state.sharedNavigation = message.payload;
        state.followingHost = null;
        state.followResponses = state.members
            .filter((clientId) => clientId !== state.hostClientId)
            .map((clientId) => ({ clientId, status: 'pending' }));

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
        }

        if (state.videoReady && state.tabId !== null) {
            sendTab(
                { type: 'APPLY_REMOTE_VIDEO', videoState: message.payload },
                state.videoFrameId,
            );
        }
    }
}

function hostPageDetected(tabId, candidate) {
    if (state.role !== 'host' || !state.room || !candidate?.hasVideo) return;

    const pageUrl = safePageUrl(candidate.pageUrl);
    if (!pageUrl) return;

    if (!state.currentVideoUrl) {
        state.currentVideoUrl = pageUrl;
        state.tabId = tabId;
        state.videoFrameId = candidate.frameId;
        state.videoReady = true;
        publish();
        return;
    }

    if (pageUrl === state.currentVideoUrl) {
        if (state.tabId !== tabId) {
            state.tabId = tabId;
            state.videoFrameId = candidate.frameId;
            state.videoReady = true;
            publish();
        }
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

            state.tabId = candidate.tabId;
            state.videoFrameId = selected?.frameId ?? candidate.frameId;
            state.videoReady = true;
            state.currentVideoUrl = url;
            state.sharedNavigation = {
                id: crypto.randomUUID(),
                url,
                title: candidate.title,
            };
            state.hostCandidate = null;
            state.followResponses = state.members
                .filter((clientId) => clientId !== state.clientId)
                .map((clientId) => ({ clientId, status: 'pending' }));
            state.status = '已分享新视频，等待成员选择是否跟随。';

            publish();
            sendRoomEvent('navigate', state.sharedNavigation);
            sendTab({ type: 'GET_VIDEO_SNAPSHOT' }, state.videoFrameId);
            return;
        }

        if (
            message.type === 'DECLINE_SHARE' &&
            state.hostCandidate &&
            sender.tab?.id === state.hostCandidate.tabId
        ) {
            state.tabId = state.hostCandidate.tabId;
            state.videoFrameId = state.hostCandidate.frameId;
            state.videoReady = false;
            state.hostCandidate = null;
            setStatus('本页未分享给房间。');
            return;
        }

        if (message.type === 'FOLLOW_DECISION' && state.pendingNavigation) {
            const navigation = state.pendingNavigation;
            const status = message.follow ? 'following' : 'not-following';

            clearNavigationNotification(navigation.id);
            state.pendingNavigation = null;
            state.followingHost = !!message.follow;
            state.status = message.follow
                ? '正在跟随主机，视频页加载后会自动同步。'
                : '已选择不跟随主机。';
            state.followResponses = state.followResponses.filter(
                (response) => response.clientId !== state.clientId,
            );
            state.followResponses.push({ clientId: state.clientId, status });

            if (message.follow) {
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
                        state.tabId = tab.id;
                        publish();
                    });
                }
            }

            publish();
            sendRoomEvent('follow-response', {
                navigationId: navigation.id,
                status,
            });
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
            state.tabId = message.tabId;

            const tab = await chrome.tabs.get(message.tabId).catch(() => null);
            state.currentVideoUrl = tab?.url || '';

            const frame = selectVideoFrame(state.tabId);
            state.videoReady = !!frame;
            state.clientId = '';
            state.hostClientId = '';
            state.members = [];
            state.memberCount = 0;
            state.dataConnections = 0;
            state.pendingNavigation = null;
            state.sharedNavigation = null;
            state.followResponses = [];
            state.followingHost = true;
            state.status = '正在创建房间…';

            publish();
            connectRoom();
            return;
        }

        if (message.type === 'JOIN_ROOM') {
            state.server = message.server || state.server;
            state.room = (message.room || '')
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 12);
            state.role = 'guest';
            state.tabId = message.tabId;

            const tab = await chrome.tabs.get(message.tabId).catch(() => null);
            state.currentVideoUrl = tab?.url || '';

            const frame = selectVideoFrame(state.tabId);
            state.videoReady = !!frame;
            state.clientId = '';
            state.memberCount = 0;
            state.dataConnections = 0;
            state.pendingNavigation = null;
            state.sharedNavigation = null;
            state.followResponses = [];
            state.followingHost = true;

            if (!state.room) {
                setStatus('请输入房间码。');
                return;
            }

            publish();
            connectRoom();
            return;
        }

        if (message.type === 'LEAVE') {
            disconnectSocket();
            sendTab({ type: 'ROOM_STOP' });
            state.room = '';
            state.role = '';
            state.clientId = '';
            state.connected = false;
            state.memberCount = 0;
            state.dataConnections = 0;
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
