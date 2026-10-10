import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT || 8787);
// ROOM_LIMIT is the server-wide ceiling; each new room can choose a smaller cap.
const configuredRoomLimit = process.env.ROOM_LIMIT
    ? Number(process.env.ROOM_LIMIT)
    : Number.NaN;
const serverRoomLimit = Number.isInteger(configuredRoomLimit)
    ? Math.max(4, Math.min(16, configuredRoomLimit))
    : 16;
const rooms = new Map();

function defaultMemberSettings() {
    return {
        // New members cannot control shared playback until the host grants it.
        canControlPlayback: false,
        canSeek: false,
        autoFollow: true,
        canManageAutoPause: false,
        autoPauseEnabled: false,
        canManagePauseOnBuffer: false,
        pauseOnBufferEnabled: false,
    };
}

// Names are plain display labels; strip control characters and cap their length.
function sanitizeDisplayName(value) {
    const name = String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 24);

    return name || '成员';
}

// HTTP is used for a simple health check; room messages travel over WebSocket.
const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Sync Watch signaling server is running. Connect to /ws.\n');
});

const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
});

// Only upgrade requests for the signaling endpoint to WebSocket connections.
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (pathname !== '/ws') {
        socket.destroy();
        return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
    });
});

webSocketServer.on('connection', (webSocket) => {
    webSocket.clientId = randomUUID();
    webSocket.room = '';

    webSocket.on('message', (rawMessage) => {
        let message;

        try {
            message = JSON.parse(rawMessage.toString());
        } catch {
            return;
        }

        if (message.type === 'ping') {
            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(JSON.stringify({ type: 'pong' }));
            }
            return;
        }

        if (message.type === 'join') {
            const roomId = String(message.room || '')
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 8);

            if (!roomId) {
                webSocket.send(
                    JSON.stringify({ type: 'error', message: '房间码无效。' }),
                );
                return;
            }

            if (webSocket.room) {
                webSocket.send(
                    JSON.stringify({
                        type: 'error',
                        message: '此连接已经加入房间。',
                    }),
                );
                return;
            }

            // Reuse the extension's stable ID so permissions survive socket reconnects.
            const requestedClientId = String(message.clientId || '');
            const clientId = /^[A-Za-z0-9-]{1,64}$/.test(requestedClientId)
                ? requestedClientId
                : webSocket.clientId;

            let room = rooms.get(roomId);
            if (!room) {
                room = new Map();
                const requestedLimit = Number(message.roomLimit);
                room.limit = Math.max(
                    4,
                    Math.min(
                        serverRoomLimit,
                        Number.isInteger(requestedLimit) ? requestedLimit : 4,
                    ),
                );
                room.sharedNavigation = null;
                room.navigationHistory = [];
                room.autoPause = { enabled: false, duration: 5 };
                room.pauseOnBuffer = false;
                room.pauseOnBufferDelay = 5;
                room.hostClientId = null;
                room.memberSettings = new Map();
                room.memberNames = new Map();
                room.recommendations = [];
                room.recommendationRateLimits = new Map();
                rooms.set(roomId, room);
            }

            if (room.size >= room.limit && !room.has(clientId)) {
                webSocket.send(
                    JSON.stringify({
                        type: 'error',
                        message: `房间已满，最多 ${room.limit} 人。`,
                    }),
                );
                return;
            }

            if (room.has(clientId)) {
                // A reconnect replaces the old socket without changing its room identity.
                room.get(clientId).close(4001, 'Member reconnected');
            }

            webSocket.clientId = clientId;
            webSocket.room = roomId;

            // Prefer the room creator when they reconnect after a server restart.
            // If no host has joined yet, the first member is a temporary fallback.
            const previousHostClientId = room.hostClientId;
            if (message.role === 'host' || !room.hostClientId) {
                room.hostClientId = clientId;
            }
            if (!room.memberSettings.has(clientId)) {
                room.memberSettings.set(clientId, defaultMemberSettings());
            }
            const displayName = room.memberNames.has(clientId)
                ? room.memberNames.get(clientId)
                : sanitizeDisplayName(message.displayName);
            room.memberNames.set(clientId, displayName);

            const existingMembers = [...room.keys()].filter(
                (existingId) => existingId !== clientId,
            );
            room.set(webSocket.clientId, webSocket);

            if (
                previousHostClientId !== room.hostClientId &&
                previousHostClientId !== null
            ) {
                const hostChange = JSON.stringify({
                    type: 'host-changed',
                    hostClientId: room.hostClientId,
                });

                for (const peer of room.values()) {
                    if (peer !== webSocket && peer.readyState === WebSocket.OPEN) {
                        peer.send(hostChange);
                    }
                }
            }

            // Give the new member the current room state and member list.
            webSocket.send(
                JSON.stringify({
                    type: 'joined',
                    clientId: webSocket.clientId,
                    peers: existingMembers,
                    limit: room.limit,
                    sharedNavigation: room.sharedNavigation,
                    navigationHistory: room.navigationHistory,
                    autoPause: room.autoPause,
                    pauseOnBuffer: room.pauseOnBuffer,
                    pauseOnBufferDelay: room.pauseOnBufferDelay,
                    hostClientId: room.hostClientId,
                    memberSettings: Object.fromEntries(room.memberSettings),
                    memberNames: Object.fromEntries(room.memberNames),
                    recommendations: room.recommendations || [],
                }),
            );

            for (const peer of room.values()) {
                if (peer !== webSocket && peer.readyState === WebSocket.OPEN) {
                    peer.send(
                        JSON.stringify({
                            type: 'peer-joined',
                            clientId: webSocket.clientId,
                            displayName,
                        }),
                    );
                }
            }
            return;
        }

        if (message.type === 'signal' && webSocket.room) {
            const room = rooms.get(webSocket.room);
            const target = room?.get(String(message.to || ''));
            const validSignalTypes = ['offer', 'answer', 'candidate'];

            if (
                target?.readyState === WebSocket.OPEN &&
                message.signal &&
                validSignalTypes.includes(message.signal.type)
            ) {
                target.send(
                    JSON.stringify({
                        type: 'signal',
                        from: webSocket.clientId,
                        signal: message.signal,
                    }),
                );
            }
            return;
        }

        if (message.type === 'room-event' && webSocket.room) {
            const allowedEvents = new Set([
                'video',
                'navigate',
                'follow-response',
                'snapshot-request',
                'snapshot',
                'member-settings',
                'member-name',
                'video-recommendation',
                'dismiss-recommendation',
                'room-settings',
                'auto-pause-ready',
                'auto-pause-start',
                'history-sync',
                'injection-status',
                'refresh-member-injection',
                'buffering-status',
                'buffering-control',
            ]);

            if (
                !allowedEvents.has(message.event) ||
                !message.payload ||
                typeof message.payload !== 'object'
            ) {
                return;
            }

            if (message.event === 'navigate') {
                try {
                    const url = new URL(message.payload.url);
                    if (!['http:', 'https:'].includes(url.protocol)) return;
                } catch {
                    return;
                }
            }

            if (message.event === 'injection-status') {
                const status = message.payload;
                message.payload = {
                    responsive: status.responsive === true,
                    frameCount: Math.max(
                        0,
                        Math.min(100, Number(status.frameCount) || 0),
                    ),
                    hasVideo: status.hasVideo === true,
                    videoBound: status.videoBound === true,
                    readyState: Math.max(
                        0,
                        Math.min(4, Number(status.readyState) || 0),
                    ),
                    videoBindingId: Math.max(
                        0,
                        Number(status.videoBindingId) || 0,
                    ),
                    pageTitle: String(status.pageTitle || '').slice(0, 160),
                    site: String(status.site || '').slice(0, 120),
                    refreshError: String(status.refreshError || '').slice(0, 160),
                };
            }

            const room = rooms.get(webSocket.room);

            if (message.event === 'refresh-member-injection') {
                const targetClientId = String(
                    message.payload.targetClientId || '',
                );
                const target = room?.get(targetClientId);

                // Only the room host can request reinjection on another member's tab.
                if (
                    webSocket.clientId !== room?.hostClientId ||
                    !target ||
                    target.readyState !== WebSocket.OPEN
                ) {
                    return;
                }

                target.send(
                    JSON.stringify({
                        type: 'room-event',
                        from: webSocket.clientId,
                        event: message.event,
                        payload: { targetClientId },
                    }),
                );
                return;
            }

            if (message.event === 'room-settings') {
                if (webSocket.clientId !== room.hostClientId) return;

                if (message.payload.autoPause) {
                    const requested = message.payload.autoPause;
                    const duration = [3, 5, 10, 'manual'].includes(
                        requested.duration,
                    )
                        ? requested.duration
                        : 5;
                    room.autoPause = {
                        enabled: requested.enabled === true,
                        duration,
                    };
                }

                if (typeof message.payload.pauseOnBuffer === 'boolean') {
                    room.pauseOnBuffer = message.payload.pauseOnBuffer;
                }

                if ([3, 5].includes(message.payload.pauseOnBufferDelay)) {
                    room.pauseOnBufferDelay = message.payload.pauseOnBufferDelay;
                }

                message.payload = {
                    autoPause: room.autoPause,
                    pauseOnBuffer: room.pauseOnBuffer,
                    pauseOnBufferDelay: room.pauseOnBufferDelay,
                };
            }

            if (message.event === 'buffering-status') {
                const memberSettings =
                    room.memberSettings.get(webSocket.clientId) ||
                    defaultMemberSettings();
                const memberCanReport = memberSettings.canManagePauseOnBuffer
                    ? memberSettings.pauseOnBufferEnabled
                    : room.pauseOnBuffer;

                if (
                    webSocket.clientId === room.hostClientId ||
                    (message.payload.buffering === true && !memberCanReport) ||
                    message.payload.navigationId !== room.sharedNavigation?.id ||
                    typeof message.payload.buffering !== 'boolean'
                ) {
                    return;
                }

                message.payload = {
                    navigationId: room.sharedNavigation.id,
                    buffering: message.payload.buffering,
                };
            }

            if (
                message.event === 'buffering-control' &&
                (webSocket.clientId !== room.hostClientId ||
                    message.payload.navigationId !== room.sharedNavigation?.id ||
                    !['pause', 'resume'].includes(message.payload.action) ||
                    typeof message.payload.pauseId !== 'string')
            ) {
                return;
            }

            if (message.event === 'history-sync') {
                if (webSocket.clientId !== room.hostClientId) return;

                const history = Array.isArray(message.payload.history)
                    ? message.payload.history
                    : [];
                const sanitizedHistory = history
                    .filter((item) => {
                        try {
                            const url = new URL(item.url);
                            return (
                                item.id &&
                                ['http:', 'https:'].includes(url.protocol)
                            );
                        } catch {
                            return false;
                        }
                    })
                    .slice(0, 15);
                const knownIds = new Set(sanitizedHistory.map((item) => item.id));
                room.navigationHistory = [
                    ...sanitizedHistory,
                    ...room.navigationHistory.filter(
                        (item) => !knownIds.has(item.id),
                    ),
                ].slice(0, 15);
                message.payload = { history: room.navigationHistory };
            }

            if (
                message.event === 'auto-pause-start' &&
                (webSocket.clientId !== room.hostClientId ||
                    message.payload.navigationId !== room.sharedNavigation?.id ||
                    typeof message.payload.pauseId !== 'string' ||
                    !Array.isArray(message.payload.targetClientIds) ||
                    (message.payload.resumeAt !== null &&
                        !Number.isFinite(message.payload.resumeAt)))
            ) {
                return;
            }

            if (message.event === 'auto-pause-start') {
                message.payload.targetClientIds = [
                    ...new Set(
                        message.payload.targetClientIds.filter((clientId) =>
                            room.has(clientId),
                        ),
                    ),
                ];
                if (!message.payload.targetClientIds.length) return;
            }

            if (
                message.event === 'auto-pause-ready' &&
                message.payload.navigationId !== room.sharedNavigation?.id
            ) {
                return;
            }

            if (
                message.event === 'buffering-control' &&
                typeof message.payload.resumePlayback !== 'boolean'
            ) {
                return;
            }

            if (
                (message.event === 'video' || message.event === 'snapshot') &&
                webSocket.clientId !== room.hostClientId
            ) {
                // Only the host may publish a snapshot as the room's source state.
                // Followers can send controls only when backed by a local gesture.
                if (message.event === 'snapshot') return;

                const memberSettings =
                    room.memberSettings.get(webSocket.clientId) ||
                    defaultMemberSettings();
                const action = message.payload.action;
                const isManualControlAction = [
                    'play',
                    'pause',
                    'seek',
                    'seeked',
                    'ratechange',
                ].includes(action);

                // Enforce room permissions before relaying a member's control to anyone.
                if (
                    (['play', 'pause'].includes(action) &&
                        !memberSettings.canControlPlayback) ||
                    (['seek', 'seeked'].includes(action) &&
                        !memberSettings.canSeek) ||
                    (isManualControlAction &&
                        message.payload.manualControl !== true) ||
                    action === 'time'
                ) {
                    return;
                }
            }

            if (message.event === 'member-settings') {
                const targetClientId = String(message.payload.targetClientId || '');
                const requestedSettings = message.payload.settings || {};
                const isHost = webSocket.clientId === room.hostClientId;
                const isSelf = webSocket.clientId === targetClientId;

                // Hosts grant preferences; a member may change only options granted to them.
                if (!room.has(targetClientId) || (!isHost && !isSelf)) return;

                const allowedSettings = isHost
                    ? [
                          'canControlPlayback',
                          'canSeek',
                          'canManageAutoPause',
                          'autoPauseEnabled',
                          'canManagePauseOnBuffer',
                          'pauseOnBufferEnabled',
                      ]
                    : ['autoPauseEnabled', 'pauseOnBufferEnabled'];
                const updates = {};

                for (const key of allowedSettings) {
                    if (typeof requestedSettings[key] === 'boolean') {
                        if (
                            !isHost &&
                            ((key === 'autoPauseEnabled' &&
                                !room.memberSettings.get(targetClientId)
                                    ?.canManageAutoPause) ||
                                (key === 'pauseOnBufferEnabled' &&
                                    !room.memberSettings.get(targetClientId)
                                        ?.canManagePauseOnBuffer))
                        ) {
                            continue;
                        }

                        updates[key] = requestedSettings[key];
                    }
                }

                if (Object.keys(updates).length === 0) return;

                const currentSettings =
                    room.memberSettings.get(targetClientId) || defaultMemberSettings();

                // When control is first granted, inherit the current room default.
                if (
                    isHost &&
                    updates.canManageAutoPause === true &&
                    !currentSettings.canManageAutoPause &&
                    !Object.hasOwn(updates, 'autoPauseEnabled')
                ) {
                    updates.autoPauseEnabled = room.autoPause.enabled;
                }
                if (
                    isHost &&
                    updates.canManagePauseOnBuffer === true &&
                    !currentSettings.canManagePauseOnBuffer &&
                    !Object.hasOwn(updates, 'pauseOnBufferEnabled')
                ) {
                    updates.pauseOnBufferEnabled = room.pauseOnBuffer;
                }

                room.memberSettings.set(targetClientId, {
                    ...currentSettings,
                    ...updates,
                });

                message.payload = {
                    targetClientId,
                    settings: updates,
                };
            }

            if (message.event === 'member-name') {
                // Each participant can choose only their own room display name.
                const displayName = sanitizeDisplayName(message.payload.name);
                room.memberNames.set(webSocket.clientId, displayName);
                message.payload = { name: displayName };
                webSocket.displayName = displayName;
            }

            if (message.event === 'video-recommendation') {
                if (webSocket.clientId === room.hostClientId) return;
                const now = Date.now();
                const lastSentAt = room.recommendationRateLimits.get(
                    webSocket.clientId,
                ) || 0;

                // Allow one recommendation per member every 15 seconds.
                if (now - lastSentAt < 15_000) {
                    webSocket.send(
                        JSON.stringify({
                            type: 'recommendation-result',
                            success: false,
                            message: '推荐太频繁，请稍后再试。',
                        }),
                    );
                    return;
                }

                let url;
                try {
                    url = new URL(message.payload.url);
                } catch {
                    webSocket.send(
                        JSON.stringify({
                            type: 'recommendation-result',
                            success: false,
                            message: '无法读取当前页面链接。',
                        }),
                    );
                    return;
                }

                // Recommendations can only point to ordinary web pages.
                if (!['http:', 'https:'].includes(url.protocol)) {
                    webSocket.send(
                        JSON.stringify({
                            type: 'recommendation-result',
                            success: false,
                            message: '只支持推荐普通网页链接。',
                        }),
                    );
                    return;
                }

                if (url.href.length > 2048) {
                    webSocket.send(
                        JSON.stringify({
                            type: 'recommendation-result',
                            success: false,
                            message: '链接过长，无法推荐。',
                        }),
                    );
                    return;
                }

                const host = room.get(room.hostClientId);
                if (!host || host.readyState !== WebSocket.OPEN) {
                    webSocket.send(
                        JSON.stringify({
                            type: 'recommendation-result',
                            success: false,
                            message: '房主当前未连接，暂时无法接收推荐。',
                        }),
                    );
                    return;
                }

                // Avoid an unbounded waiting list when the host is away.
                if (room.recommendations.length >= 20) {
                    webSocket.send(
                        JSON.stringify({
                            type: 'recommendation-result',
                            success: false,
                            message: '房主的推荐列表已满，请稍后再试。',
                        }),
                    );
                    return;
                }

                const recommendation = {
                    id: randomUUID(),
                    from: webSocket.clientId,
                    name: room.memberNames.get(webSocket.clientId) || '成员',
                    title: String(message.payload.title || url.hostname)
                        .replace(/[\u0000-\u001f\u007f]/g, '')
                        .slice(0, 160),
                    url: url.href,
                    hostname: url.hostname,
                    createdAt: now,
                };
                room.recommendationRateLimits.set(webSocket.clientId, now);
                room.recommendations.unshift(recommendation);
                webSocket.send(
                    JSON.stringify({
                        type: 'recommendation-result',
                        success: true,
                        message: '已推荐给房主。',
                    }),
                );
                host.send(
                    JSON.stringify({
                        type: 'room-event',
                        from: webSocket.clientId,
                        event: message.event,
                        payload: recommendation,
                    }),
                );

                return;
            }

            if (message.event === 'dismiss-recommendation') {
                if (webSocket.clientId !== room.hostClientId) return;
                const id = String(message.payload.id || '');
                room.recommendations = room.recommendations.filter(
                    (item) => item.id !== id,
                );
                const update = JSON.stringify({
                    type: 'room-event',
                    from: webSocket.clientId,
                    event: message.event,
                    payload: { id },
                });
                for (const peer of room.values()) {
                    if (peer !== webSocket && peer.readyState === WebSocket.OPEN) {
                        peer.send(update);
                    }
                }
                return;
            }


            if (message.event === 'navigate') {
                if (webSocket.clientId !== room.hostClientId) return;
                room.sharedNavigation = message.payload;
                room.navigationHistory = [
                    message.payload,
                    ...room.navigationHistory.filter(
                        (item) => item.id !== message.payload.id,
                    ),
                ].slice(0, 15);
            }

            const roomEvent = JSON.stringify({
                type: 'room-event',
                from: webSocket.clientId,
                event: message.event,
                payload: message.payload,
            });

            // The server relays signaling data only; it never receives video media.
            for (const peer of room?.values() || []) {
                if (
                    peer !== webSocket &&
                    peer.readyState === WebSocket.OPEN &&
                    (message.event !== 'injection-status' ||
                        peer.clientId === room.hostClientId) &&
                    (message.event !== 'buffering-status' ||
                        peer.clientId === room.hostClientId)
                ) {
                    peer.send(roomEvent);
                }
            }
        }
    });

    function removeMember() {
        if (!webSocket.room) return;

        const room = rooms.get(webSocket.room);
        const isCurrentConnection = room?.get(webSocket.clientId) === webSocket;

        // An older socket may close after a reconnect has already replaced it.
        if (isCurrentConnection) room.delete(webSocket.clientId);

        if (room && isCurrentConnection) {
            for (const peer of room.values()) {
                if (peer.readyState === WebSocket.OPEN) {
                    peer.send(
                        JSON.stringify({
                            type: 'peer-left',
                            clientId: webSocket.clientId,
                        }),
                    );
                }
            }
        }

        if (room && room.size === 0) rooms.delete(webSocket.room);
        webSocket.room = '';
    }

    webSocket.on('close', removeMember);
    webSocket.on('error', removeMember);
});

server.listen(port, '0.0.0.0', () => {
    console.log(
        `Sync Watch signaling server listening on :${port}; maximum room limit ${serverRoomLimit}`,
    );
});
