import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT || 8787);
const roomLimit = Math.max(2, Math.min(64, Number(process.env.ROOM_LIMIT || 4)));
const rooms = new Map();
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Sync Watch signaling server is running. Connect to /ws.\n');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  ws.clientId = randomUUID();
  ws.room = '';
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ping') { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (msg.type === 'join') {
      const roomId = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!roomId) { ws.send(JSON.stringify({ type: 'error', message: '房间码无效。' })); return; }
      if (ws.room) { ws.send(JSON.stringify({ type: 'error', message: '此连接已经加入房间。' })); return; }
      let room = rooms.get(roomId);
      if (!room) { room = new Map(); room.sharedNavigation = null; rooms.set(roomId, room); }
      if (room.size >= roomLimit) { ws.send(JSON.stringify({ type: 'error', message: `房间已满，最多 ${roomLimit} 人。` })); return; }
      ws.room = roomId;
      const existing = [...room.keys()];
      room.set(ws.clientId, ws);
      ws.send(JSON.stringify({ type: 'joined', clientId: ws.clientId, peers: existing, limit: roomLimit, sharedNavigation: room.sharedNavigation }));
      for (const peer of room.values()) if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'peer-joined', clientId: ws.clientId }));
      return;
    }
    if (msg.type === 'signal' && ws.room) {
      const room = rooms.get(ws.room);
      const target = room?.get(String(msg.to || ''));
      if (target?.readyState === WebSocket.OPEN && msg.signal && ['offer', 'answer', 'candidate'].includes(msg.signal.type)) {
        target.send(JSON.stringify({ type: 'signal', from: ws.clientId, signal: msg.signal }));
      }
      return;
    }
    if (msg.type === 'room-event' && ws.room) {
      const allowedEvents = new Set(['video', 'navigate', 'follow-response', 'snapshot-request', 'snapshot']);
      if (!allowedEvents.has(msg.event) || !msg.payload || typeof msg.payload !== 'object') return;
      if (msg.event === 'navigate') {
        try { const url = new URL(msg.payload.url); if (!['http:', 'https:'].includes(url.protocol)) return; }
        catch { return; }
      }
      const room = rooms.get(ws.room);
      if (msg.event === 'navigate') room.sharedNavigation = msg.payload;
      const event = JSON.stringify({ type: 'room-event', from: ws.clientId, event: msg.event, payload: msg.payload });
      for (const peer of room?.values() || []) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(event);
      }
    }
  });
  const cleanup = () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    room?.delete(ws.clientId);
    if (room) for (const peer of room.values()) if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'peer-left', clientId: ws.clientId }));
    if (room && room.size === 0) rooms.delete(ws.room);
    ws.room = '';
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(port, '0.0.0.0', () => console.log(`Sync Watch signaling server listening on :${port}; room limit ${roomLimit}`));
