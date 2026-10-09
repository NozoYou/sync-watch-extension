import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT || 8787);
const roomLimit = Math.max(2, Math.min(64, Number(process.env.ROOM_LIMIT || 4)));
const rooms = new Map();

function defaultMemberSettings() {
    return {
        canControlPlayback: true,
        canSeek: true,
        autoFollow: false,
    };
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
                room.sharedNavigation = null;
                room.hostClientId = null;
                room.memberSettings = new Map();
                rooms.set(roomId, room);
            }

            if (room.size >= roomLimit && !room.has(clientId)) {
                webSocket.send(
                    JSON.stringify({
                        type: 'error',
                        message: `房间已满，最多 ${roomLimit} 人。`,
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
                    limit: roomLimit,
                    sharedNavigation: room.sharedNavigation,
                    hostClientId: room.hostClientId,
                    memberSettings: Object.fromEntries(room.memberSettings),
                }),
            );

            for (const peer of room.values()) {
                if (peer !== webSocket && peer.readyState === WebSocket.OPEN) {
                    peer.send(
                        JSON.stringify({
                            type: 'peer-joined',
                            clientId: webSocket.clientId,
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

            const room = rooms.get(webSocket.room);

            if (
                (message.event === 'video' || message.event === 'snapshot') &&
                webSocket.clientId !== room.hostClientId
            ) {
                const memberSettings =
                    room.memberSettings.get(webSocket.clientId) ||
                    defaultMemberSettings();
                const action = message.payload.action;

                // Enforce room permissions before relaying a member's control to anyone.
                if (
                    (['play', 'pause'].includes(action) &&
                        !memberSettings.canControlPlayback) ||
                    (action === 'seeked' && !memberSettings.canSeek) ||
                    ['time', 'seek'].includes(action)
                ) {
                    return;
                }
            }

            if (message.event === 'member-settings') {
                const targetClientId = String(message.payload.targetClientId || '');
                const requestedSettings = message.payload.settings || {};
                const isHost = webSocket.clientId === room.hostClientId;
                const isSelf = webSocket.clientId === targetClientId;

                // Hosts manage all three settings; members may change their own auto-follow option.
                if (!room.has(targetClientId) || (!isHost && !isSelf)) return;

                const allowedSettings = isHost
                    ? ['canControlPlayback', 'canSeek', 'autoFollow']
                    : ['autoFollow'];
                const updates = {};

                for (const key of allowedSettings) {
                    if (typeof requestedSettings[key] === 'boolean') {
                        updates[key] = requestedSettings[key];
                    }
                }

                if (Object.keys(updates).length === 0) return;

                const currentSettings =
                    room.memberSettings.get(targetClientId) || defaultMemberSettings();
                room.memberSettings.set(targetClientId, {
                    ...currentSettings,
                    ...updates,
                });

                message.payload = {
                    targetClientId,
                    settings: updates,
                };
            }

            if (message.event === 'navigate') {
                room.sharedNavigation = message.payload;
            }

            const roomEvent = JSON.stringify({
                type: 'room-event',
                from: webSocket.clientId,
                event: message.event,
                payload: message.payload,
            });

            // The server relays signaling data only; it never receives video media.
            for (const peer of room?.values() || []) {
                if (peer !== webSocket && peer.readyState === WebSocket.OPEN) {
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
        `Sync Watch signaling server listening on :${port}; room limit ${roomLimit}`,
    );
});
