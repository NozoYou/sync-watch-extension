// The service worker owns room state and keeps the signaling socket alive
// while users move between video tabs.
let socket = null;
let pingTimer = null;
let reconnectTimer = null;

const videoFrames = new Map();
const injectionFrames = new Map();
const navigationNotificationPrefix = 'sync-watch-navigation-';

const state = {
    server: '',
    turnUrls: '',
    turnUsername: '',
    turnCredential: '',
    room: '',
    role: '',
    modifyTabIcon: false,
    autoReinjectSamePage: false,
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
    memberInjectionStatus: {},
    navigationHistory: [],
    autoPause: { enabled: false, duration: 5 },
    autoPauseReady: [],
    autoPauseStartedNavigationId: '',
    pauseOnBuffer: false,
    pauseOnBufferDelay: 5,
    bufferingMembers: [],
    bufferPause: null,
    currentVideoUrl: '',
    currentPlayback: null,
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
        'autoReinjectSamePage',
        'tabId',
        'videoFrameId',
        'videoReady',
        'clientId',
        'hostClientId',
        'members',
        'memberSettings',
        'memberInjectionStatus',
        'navigationHistory',
        'autoPause',
        'autoPauseReady',
        'autoPauseStartedNavigationId',
        'pauseOnBuffer',
        'pauseOnBufferDelay',
        'bufferingMembers',
        'bufferPause',
        'currentVideoUrl',
        'currentPlayback',
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
        autoReinjectSamePage: state.autoReinjectSamePage,
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
        memberInjectionStatus: state.memberInjectionStatus,
        navigationHistory: state.navigationHistory,
        autoPause: state.autoPause,
        autoPauseReady: state.autoPauseReady,
        autoPauseStartedNavigationId: state.autoPauseStartedNavigationId,
        pauseOnBuffer: state.pauseOnBuffer,
        pauseOnBufferDelay: state.pauseOnBufferDelay,
        bufferingMembers: state.bufferingMembers,
        bufferPause: state.bufferPause,
        currentVideoUrl: state.currentVideoUrl,
        currentPlayback: state.currentPlayback,
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
        canManageAutoPause: false,
        autoPauseEnabled: false,
        canManagePauseOnBuffer: false,
        pauseOnBufferEnabled: false,
    };
}

function getMemberSettings(clientId) {
    if (!state.memberSettings[clientId]) {
        state.memberSettings[clientId] = defaultMemberSettings();
    }

    return state.memberSettings[clientId];
}

function isAutoPauseEnabledForMember(clientId) {
    if (clientId === state.clientId) return !!state.autoPause.enabled;

    const settings = getMemberSettings(clientId);
    return settings.canManageAutoPause
        ? settings.autoPauseEnabled
        : !!state.autoPause.enabled;
}

function isBufferPauseEnabledForMember(clientId) {
    if (clientId === state.clientId) return !!state.pauseOnBuffer;

    const settings = getMemberSettings(clientId);
    return settings.canManagePauseOnBuffer
        ? settings.pauseOnBufferEnabled
        : !!state.pauseOnBuffer;
}

function sendBufferingSettings() {
    sendTab(
        {
            type: 'BUFFERING_SETTINGS',
            delay: state.pauseOnBufferDelay,
            enabled: isBufferPauseEnabledForMember(state.clientId),
        },
        state.videoFrameId,
    );
}

function sendRoomTabState(frameId = state.videoFrameId) {
    sendTab(
        {
            type: 'ROOM_CONNECTED',
            role: state.role,
            bufferingDelay: state.pauseOnBufferDelay,
            bufferingEnabled: isBufferPauseEnabledForMember(state.clientId),
        },
        frameId,
    );
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

function publishInjectionStatus() {
    if (!state.room || !state.connected || !state.clientId) return;

    const now = Date.now();
    const activeFrames = [...injectionFrames.values()].filter(
        (frame) =>
            frame.tabId === state.tabId &&
            now - frame.reportedAt < 12_000,
    );
    const bestFrame = activeFrames
        .filter((frame) => frame.hasVideo)
        .sort((a, b) => Number(b.videoBound) - Number(a.videoBound))[0];
    const status = {
        responsive: activeFrames.length > 0,
        frameCount: activeFrames.length,
        hasVideo: activeFrames.some((frame) => frame.hasVideo),
        videoBound: activeFrames.some((frame) => frame.videoBound),
        readyState: bestFrame?.readyState || 0,
        videoBindingId: bestFrame?.videoBindingId || 0,
        pageTitle: bestFrame?.pageTitle || activeFrames[0]?.pageTitle || '',
        site: bestFrame?.site || activeFrames[0]?.site || '',
        reportedAt: now,
    };

    state.memberInjectionStatus[state.clientId] = {
        ...status,
        receivedAt: now,
    };
    sendRoomEvent('injection-status', status);
    publish();
}

async function resolveRoomTab() {
    if (state.tabId !== null) {
        const currentTab = await chrome.tabs.get(state.tabId).catch(() => null);
        if (currentTab) return currentTab.id;
        state.tabId = null;
    }

    if (!state.currentVideoUrl) return null;

    // A member may close the watched tab and reopen the same page while staying
    // in the room. Rebind to that page before a host or member requests injection.
    const matchingFrame = [...videoFrames.values()]
        .filter((frame) => frame.pageUrl === state.currentVideoUrl)
        .sort((a, b) => Number(b.hasVideo) - Number(a.hasVideo))[0];

    if (matchingFrame) return matchingFrame.tabId;

    const matchingTab = (await chrome.tabs.query({})).find(
        (tab) => tab.url === state.currentVideoUrl,
    );

    return matchingTab?.id ?? null;
}

async function reinjectRoomTab() {
    if (state.tabId === null) {
        const matchingTabId = await resolveRoomTab();
        if (matchingTabId !== null) switchRoomTab(matchingTabId);
    }

    if (state.tabId === null) {
        throw new Error('找不到房间正在播放的网页。请先打开相同视频页后重试。');
    }

    // Discard old frame heartbeats so the UI waits for the new script instance.
    for (const [key, frame] of injectionFrames) {
        if (frame.tabId === state.tabId) injectionFrames.delete(key);
    }

    const injectedFrames = await chrome.scripting.executeScript({
        target: { tabId: state.tabId, allFrames: true },
        files: ['content.js'],
    });

    setTabMarker(state.tabId, true);
    state.status = '重新注入已执行，正在等待页面状态回报。';
    publish();
    return injectedFrames.length;
}

async function handleReinjectionRequest(clientId) {
    state.memberInjectionStatus[clientId] = {
        refreshing: true,
        receivedAt: Date.now(),
    };

    if (clientId !== state.clientId) {
        sendRoomEvent('refresh-member-injection', {
            targetClientId: clientId,
        });
        publish();
        return;
    }

    publish();

    try {
        await reinjectRoomTab();
    } catch (error) {
        state.memberInjectionStatus[clientId] = {
            refreshing: false,
            refreshError: String(error?.message || error).slice(0, 160),
            receivedAt: Date.now(),
        };
        state.status = '重新注入失败；请检查页面是否允许扩展访问。';
        publish();
    }
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
        !state.sharedNavigation?.id ||
        state.autoPauseStartedNavigationId === state.sharedNavigation.id
    ) {
        return;
    }

    const targetClientIds = [];

    if (isAutoPauseEnabledForMember(state.clientId)) {
        targetClientIds.push(state.clientId);
    }

    for (const response of state.followResponses) {
        if (
            response.status === 'following' &&
            isAutoPauseEnabledForMember(response.clientId)
        ) {
            targetClientIds.push(response.clientId);
        }
    }

    if (
        !targetClientIds.length ||
        targetClientIds.some(
            (clientId) => !state.autoPauseReady.includes(clientId),
        )
    ) {
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
        targetClientIds,
    };

    state.autoPauseStartedNavigationId = state.sharedNavigation.id;
    publish();
    if (targetClientIds.includes(state.clientId)) {
        sendTab({ type: 'AUTO_PAUSE', ...payload }, state.videoFrameId);
    }
    sendRoomEvent('auto-pause-start', payload);
}

function startBufferingPause() {
    if (
        state.role !== 'host' ||
        !state.bufferingMembers.length ||
        !state.sharedNavigation?.id ||
        state.bufferPause
    ) {
        return;
    }

    const payload = {
        action: 'pause',
        pauseId: crypto.randomUUID(),
        navigationId: state.sharedNavigation.id,
        resumePlayback: state.currentPlayback?.paused !== true,
    };
    state.bufferPause = payload;
    sendTab({ type: 'BUFFERING_CONTROL', ...payload }, state.videoFrameId);
    sendRoomEvent('buffering-control', payload);
    publish();
}

function finishBufferingPause() {
    if (state.role !== 'host' || !state.bufferPause) return;

    const previousPause = state.bufferPause;
    const payload = {
        action: 'resume',
        pauseId: previousPause.pauseId,
        navigationId: previousPause.navigationId,
        resumePlayback:
            previousPause.resumePlayback && state.currentPlayback?.paused !== true,
    };

    state.bufferPause = null;
    sendTab({ type: 'BUFFERING_CONTROL', ...payload }, state.videoFrameId);
    sendRoomEvent('buffering-control', payload);
    publish();
}

function updateBufferingMember(clientId, isBuffering) {
    if (!state.bufferingMembers.includes(clientId) && isBuffering) {
        state.bufferingMembers.push(clientId);
    } else if (!isBuffering) {
        state.bufferingMembers = state.bufferingMembers.filter(
            (memberId) => memberId !== clientId,
        );
    }

    if (state.bufferingMembers.length) {
        startBufferingPause();
    } else {
        finishBufferingPause();
    }
    publish();
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
            state.memberInjectionStatus = {};
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
            state.pauseOnBuffer = message.pauseOnBuffer === true;
            state.pauseOnBufferDelay = [3, 5].includes(
                message.pauseOnBufferDelay,
            )
                ? message.pauseOnBufferDelay
                : 5;
            state.autoPauseReady = [];
            state.bufferingMembers = [];
            state.bufferPause = null;

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
                sendRoomTabState();
                setTabMarker(state.tabId, true);
            }

            publishInjectionStatus();

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
            delete state.memberInjectionStatus[message.clientId];
            state.bufferingMembers = state.bufferingMembers.filter(
                (clientId) => clientId !== message.clientId,
            );
            state.memberCount = state.members.length;
            state.followResponses = state.followResponses.filter(
                (response) => response.clientId !== message.clientId,
            );
            state.autoPauseReady = state.autoPauseReady.filter(
                (clientId) => clientId !== message.clientId,
            );
            startAutoPauseWhenReady();
            if (!state.bufferingMembers.length) finishBufferingPause();
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
        message.event === 'refresh-member-injection' &&
        message.payload?.targetClientId === state.clientId
    ) {
        reinjectRoomTab().catch((error) => {
            const refreshError = String(error?.message || error).slice(0, 160);
            state.memberInjectionStatus[state.clientId] = {
                refreshing: false,
                refreshError,
                receivedAt: Date.now(),
            };
            sendRoomEvent('injection-status', {
                responsive: false,
                frameCount: 0,
                hasVideo: false,
                videoBound: false,
                readyState: 0,
                videoBindingId: 0,
                pageTitle: '',
                site: '',
                refreshError,
            });
            publish();
        });
        return;
    }

    if (
        message.event === 'injection-status' &&
        state.members.includes(message.from)
    ) {
        state.memberInjectionStatus[message.from] = {
            ...message.payload,
            receivedAt: Date.now(),
        };
        publish();
        return;
    }

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
        state.pauseOnBuffer = message.payload?.pauseOnBuffer === true;
        state.pauseOnBufferDelay = [3, 5].includes(
            message.payload?.pauseOnBufferDelay,
        )
            ? message.payload.pauseOnBufferDelay
            : 5;
        sendBufferingSettings();
        if (state.role === 'host' && !state.pauseOnBuffer) {
            updateBufferingMember(state.clientId, false);
        }
        publish();
        return;
    }

    if (
        message.event === 'buffering-status' &&
        state.role === 'host' &&
        message.payload?.navigationId === state.sharedNavigation?.id &&
        state.members.includes(message.from)
    ) {
        const memberResponse = state.followResponses.find(
            (response) => response.clientId === message.from,
        );

        if (message.payload.buffering === false) {
            updateBufferingMember(message.from, false);
        } else if (
            message.payload.buffering === true &&
            memberResponse?.status === 'following'
        ) {
            updateBufferingMember(message.from, true);
        }
        return;
    }

    if (
        message.event === 'buffering-control' &&
        state.role !== 'host' &&
        message.payload?.navigationId === state.sharedNavigation?.id &&
        state.followingHost === true
    ) {
        sendTab(
            { type: 'BUFFERING_CONTROL', ...message.payload },
            state.videoFrameId,
        );
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
        state.followingHost === true &&
        (!Array.isArray(message.payload.targetClientIds) ||
            message.payload.targetClientIds.includes(state.clientId))
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
        const isOwnMemberPreferenceUpdate =
            message.from === targetClientId &&
            (targetClientId === state.clientId || state.role === 'host');

        // The host manages permissions; a member can edit only delegated preferences.
        if (!targetClientId || (!isHostUpdate && !isOwnMemberPreferenceUpdate)) return;

        const allowedKeys = isHostUpdate
            ? [
                  'canControlPlayback',
                  'canSeek',
                  'autoFollow',
                  'canManageAutoPause',
                  'autoPauseEnabled',
                  'canManagePauseOnBuffer',
                  'pauseOnBufferEnabled',
              ]
            : ['autoFollow', 'autoPauseEnabled', 'pauseOnBufferEnabled'];
        const currentSettings = getMemberSettings(targetClientId);

        for (const key of allowedKeys) {
            if (typeof updates[key] === 'boolean') {
                currentSettings[key] = updates[key];
            }
        }

        if (targetClientId === state.clientId) sendBufferingSettings();
        if (
            state.role === 'host' &&
            (Object.hasOwn(updates, 'canManageAutoPause') ||
                updates.autoPauseEnabled === true)
        ) {
            state.autoPauseStartedNavigationId = '';
            startAutoPauseWhenReady();
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
        state.currentPlayback = null;
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

        // Reflect the latest accepted room action in every member's popup.
        state.currentPlayback = {
            ...message.payload,
            title:
                message.payload.title ||
                state.sharedNavigation?.title ||
                '当前视频',
        };
        publish();

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
        sendRoomTabState(candidate.frameId);

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
        const restoringClosedTab = state.tabId === null;
        if (restoringClosedTab && !state.autoReinjectSamePage) return;

        if (
            state.tabId !== tabId ||
            state.videoFrameId !== candidate.frameId ||
            !state.videoReady
        ) {
            switchRoomTab(tabId);
            state.videoFrameId = candidate.frameId;
            state.videoReady = true;
            sendRoomTabState(candidate.frameId);
            publish();

            if (restoringClosedTab) {
                void handleReinjectionRequest(state.clientId);
            }
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
        if (message.type === 'REFRESH_MY_INJECTION') {
            if (state.room && state.clientId) {
                await handleReinjectionRequest(state.clientId);
            }
            return;
        }

        if (message.type === 'REFRESH_MEMBER_INJECTION') {
            const targetClientId = String(message.clientId || '');
            const isSelf = targetClientId === state.clientId;
            const canRefreshMember =
                state.role === 'host' && state.members.includes(targetClientId);

            if (isSelf || canRefreshMember) {
                await handleReinjectionRequest(targetClientId);
            }
            return;
        }

        if (
            message.type === 'INJECTION_STATUS' &&
            sender.tab?.id !== undefined
        ) {
            const tabId = sender.tab.id;
            const frameId = sender.frameId || 0;
            const status = message.status || {};

            injectionFrames.set(`${tabId}:${frameId}`, {
                tabId,
                frameId,
                injected: status.injected === true,
                hasVideo: status.hasVideo === true,
                videoBound: status.videoBound === true,
                readyState: Number(status.readyState) || 0,
                videoBindingId: Number(status.videoBindingId) || 0,
                pageTitle: String(status.pageTitle || '').slice(0, 160),
                site: String(status.site || '').slice(0, 120),
                reportedAt: Date.now(),
            });

            if (tabId === state.tabId) publishInjectionStatus();
            return;
        }

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

            // Restore the member's room tab when they reopened the same video
            // page without leaving the room.
            if (
                state.room &&
                state.role !== 'host' &&
                state.autoReinjectSamePage &&
                state.tabId === null &&
                candidate.pageUrl === state.currentVideoUrl
            ) {
                switchRoomTab(tabId);
                await handleReinjectionRequest(state.clientId);
            }

            if (tabId === state.tabId) {
                setTabMarker(tabId, true);
                const wasReady = state.videoReady;
                const previousVideoFrameId = state.videoFrameId;
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

                if (
                    selected &&
                    (!wasReady || previousVideoFrameId !== selected.frameId)
                ) {
                    sendRoomTabState(selected.frameId);
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

            // A manual host pause during a buffering pause should prevent auto-resume.
            if (state.role === 'host' && state.bufferPause && action === 'pause') {
                state.bufferPause.resumePlayback = false;
            } else if (
                state.role === 'host' &&
                state.bufferPause &&
                action === 'play'
            ) {
                finishBufferingPause();
            }

            if (
                state.role !== 'host' &&
                !message.snapshot &&
                !canSendPlaybackAction(ownSettings, action)
            ) {
                return;
            }

            // Forward seek samples for smooth dragging; periodic clock samples from
            // followers would still fight the host's playback clock.
            if (
                state.role !== 'host' &&
                !message.snapshot &&
                message.videoState?.action === 'time'
            ) {
                return;
            }

            sendRoomEvent(
                message.snapshot ? 'snapshot' : 'video',
                message.videoState,
            );

            if (state.role === 'host') {
                state.currentPlayback = {
                    ...message.videoState,
                    title:
                        message.videoState.title ||
                        state.sharedNavigation?.title ||
                        '当前视频',
                };
                publish();
            }
            return;
        }

        if (
            message.type === 'BUFFERING_STATUS' &&
            sender.tab?.id === state.tabId &&
            (sender.frameId || 0) === state.videoFrameId &&
            state.room &&
            state.connected &&
            state.videoReady &&
            state.sharedNavigation?.id
        ) {
            const isBuffering = message.buffering === true;
            const enabledForMember = isBufferPauseEnabledForMember(
                state.clientId,
            );

            if (state.role === 'host') {
                if (!isBuffering || enabledForMember) {
                    updateBufferingMember(state.clientId, isBuffering);
                }
            } else if (
                state.followingHost === true &&
                (!isBuffering || enabledForMember)
            ) {
                sendRoomEvent('buffering-status', {
                    navigationId: state.sharedNavigation.id,
                    buffering: isBuffering,
                });
            }
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

            // End any buffering pause against the old video before switching IDs.
            finishBufferingPause();
            state.bufferingMembers = [];

            switchRoomTab(candidate.tabId);
            state.videoFrameId = selected?.frameId ?? candidate.frameId;
            state.videoReady = true;
            sendRoomTabState(state.videoFrameId);
            state.currentVideoUrl = url;
            state.currentPlayback = null;
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
            message.type === 'APPLY_MEMBER_SETTINGS_TO_ROOM' &&
            state.role === 'host' &&
            state.connected
        ) {
            const { sourceClientId, settings: requestedSettings } = message;
            const allowedKeys = [
                'canControlPlayback',
                'canSeek',
                'autoFollow',
                'canManageAutoPause',
                'canManagePauseOnBuffer',
            ];

            if (
                !state.members.includes(sourceClientId) ||
                sourceClientId === state.hostClientId ||
                !requestedSettings ||
                typeof requestedSettings !== 'object'
            ) {
                return;
            }

            const permissionSettings = Object.fromEntries(
                allowedKeys
                    .filter((key) => typeof requestedSettings[key] === 'boolean')
                    .map((key) => [key, requestedSettings[key]]),
            );

            if (Object.keys(permissionSettings).length === 0) return;

            for (const targetClientId of state.members) {
                if (
                    targetClientId === state.hostClientId ||
                    targetClientId === sourceClientId
                ) {
                    continue;
                }

                const targetSettings = getMemberSettings(targetClientId);
                const settingsUpdate = { ...permissionSettings };

                // Newly delegated switches inherit the current room defaults.
                if (
                    settingsUpdate.canManageAutoPause === true &&
                    !targetSettings.canManageAutoPause
                ) {
                    settingsUpdate.autoPauseEnabled =
                        !!state.autoPause.enabled;
                }
                if (
                    settingsUpdate.canManagePauseOnBuffer === true &&
                    !targetSettings.canManagePauseOnBuffer
                ) {
                    settingsUpdate.pauseOnBufferEnabled =
                        !!state.pauseOnBuffer;
                }

                Object.assign(targetSettings, settingsUpdate);
                sendRoomEvent('member-settings', {
                    targetClientId,
                    settings: settingsUpdate,
                });
            }

            publish();
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
                'canManageAutoPause',
                'canManagePauseOnBuffer',
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

            const settingsUpdate = { [key]: settings[key] };
            if (key === 'canManageAutoPause' && settings[key]) {
                settings.autoPauseEnabled = !!state.autoPause.enabled;
                settingsUpdate.autoPauseEnabled = settings.autoPauseEnabled;
            }
            if (key === 'canManagePauseOnBuffer' && settings[key]) {
                settings.pauseOnBufferEnabled = !!state.pauseOnBuffer;
                settingsUpdate.pauseOnBufferEnabled =
                    settings.pauseOnBufferEnabled;
            }

            publish();
            sendRoomEvent('member-settings', {
                targetClientId,
                settings: settingsUpdate,
            });
            return;
        }

        if (message.type === 'SET_AUTO_PAUSE' && state.connected) {
            if (state.role !== 'host') {
                const settings = getMemberSettings(state.clientId);
                if (!settings.canManageAutoPause) return;

                settings.autoPauseEnabled = !!message.enabled;
                publish();
                sendRoomEvent('member-settings', {
                    targetClientId: state.clientId,
                    settings: { autoPauseEnabled: settings.autoPauseEnabled },
                });
                return;
            }

            const requestedDuration =
                message.duration === 'manual'
                    ? 'manual'
                    : Number(message.duration);
            const duration = [3, 5, 10].includes(requestedDuration)
                ? requestedDuration
                : requestedDuration === 'manual'
                  ? 'manual'
                  : 5;
            const wasEnabled = state.autoPause.enabled;
            state.autoPause = {
                enabled: !!message.enabled,
                duration,
            };
            if (!wasEnabled && state.autoPause.enabled) {
                state.autoPauseStartedNavigationId = '';
            }
            publish();
            sendRoomEvent('room-settings', {
                autoPause: state.autoPause,
                pauseOnBuffer: state.pauseOnBuffer,
                pauseOnBufferDelay: state.pauseOnBufferDelay,
            });
            if (state.autoPause.enabled && !wasEnabled) {
                startAutoPauseWhenReady();
            }
            return;
        }

        if (message.type === 'SET_PAUSE_ON_BUFFER' && state.connected) {
            if (state.role === 'host') {
                state.pauseOnBuffer = !!message.enabled;
                state.pauseOnBufferDelay = [3, 5].includes(Number(message.delay))
                    ? Number(message.delay)
                    : 5;

                if (!state.pauseOnBuffer) {
                    updateBufferingMember(state.clientId, false);
                }

                sendBufferingSettings();
                publish();
                sendRoomEvent('room-settings', {
                    autoPause: state.autoPause,
                    pauseOnBuffer: state.pauseOnBuffer,
                    pauseOnBufferDelay: state.pauseOnBufferDelay,
                });
                return;
            }

            const settings = getMemberSettings(state.clientId);
            if (!settings.canManagePauseOnBuffer) return;

            settings.pauseOnBufferEnabled = !!message.enabled;
            sendBufferingSettings();
            publish();
            sendRoomEvent('member-settings', {
                targetClientId: state.clientId,
                settings: {
                    pauseOnBufferEnabled: settings.pauseOnBufferEnabled,
                },
            });
            return;
        }

        if (message.type === 'SET_TAB_ICON') {
            state.modifyTabIcon = !!message.enabled;
            publish();
            setTabMarker(state.tabId, !!state.room);
            return;
        }

        if (message.type === 'SET_AUTO_REINJECT_SAME_PAGE') {
            state.autoReinjectSamePage = !!message.enabled;
            publish();

            if (
                state.autoReinjectSamePage &&
                state.room &&
                state.tabId === null
            ) {
                const matchingTabId = await resolveRoomTab();
                if (matchingTabId !== null) {
                    switchRoomTab(matchingTabId);
                    const selected = selectVideoFrame(matchingTabId);

                    if (selected) {
                        state.currentVideoUrl = selected.pageUrl;
                        state.videoReady = selected.hasVideo;
                        sendRoomTabState(selected.frameId);
                        publishInjectionStatus();
                        await handleReinjectionRequest(state.clientId);
                    }
                }
            }
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
            state.currentPlayback = null;

            const frame = selectVideoFrame(state.tabId);
            state.videoReady = !!frame;
            state.clientId = '';
            state.hostClientId = '';
            state.members = [];
            state.memberInjectionStatus = {};
            state.memberSettings = {};
            state.navigationHistory = [];
            state.autoPause = { enabled: false, duration: 5 };
            state.pauseOnBuffer = false;
            state.pauseOnBufferDelay = 5;
            state.bufferingMembers = [];
            state.bufferPause = null;
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
            state.currentPlayback = null;

            const frame = selectVideoFrame(state.tabId);
            state.videoReady = !!frame;
            state.clientId = '';
            state.hostClientId = '';
            state.memberCount = 0;
            state.members = [];
            state.memberInjectionStatus = {};
            state.memberSettings = {};
            state.navigationHistory = [];
            state.autoPause = { enabled: false, duration: 5 };
            state.pauseOnBuffer = false;
            state.pauseOnBufferDelay = 5;
            state.bufferingMembers = [];
            state.bufferPause = null;
            state.autoPauseReady = [];
            state.autoPauseStartedNavigationId = '';
            state.dataConnections = 0;
            state.pendingNavigation = null;
            state.sharedNavigation = null;
            state.currentPlayback = null;
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
            state.memberInjectionStatus = {};
            state.memberSettings = {};
            state.navigationHistory = [];
            state.autoPause = { enabled: false, duration: 5 };
            state.pauseOnBuffer = false;
            state.pauseOnBufferDelay = 5;
            state.bufferingMembers = [];
            state.bufferPause = null;
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
        state.status = '房间仍连接；播放标签页已关闭，打开相同视频页可重新连接。';
        publishInjectionStatus();
    }
});
