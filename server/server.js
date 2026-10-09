import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT || 8787);
const roomLimit = Math.max(2, Math.min(64, Number(process.env.ROOM_LIMIT || 4)));
const rooms = new Map();

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

            let room = rooms.get(roomId);
            if (!room) {
                room = new Map();
                room.sharedNavigation = null;
                rooms.set(roomId, room);
            }

            if (room.size >= roomLimit) {
                webSocket.send(
                    JSON.stringify({
                        type: 'error',
                        message: `房间已满，最多 ${roomLimit} 人。`,
                    }),
                );
                return;
            }

            webSocket.room = roomId;
            const existingMembers = [...room.keys()];
            room.set(webSocket.clientId, webSocket);

            // Give the new member the current room state and member list.
            webSocket.send(
                JSON.stringify({
                    type: 'joined',
                    clientId: webSocket.clientId,
                    peers: existingMembers,
                    limit: roomLimit,
                    sharedNavigation: room.sharedNavigation,
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
        room?.delete(webSocket.clientId);

        if (room) {
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
