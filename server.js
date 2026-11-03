import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PUBLIC_DIR = new URL('./public/', import.meta.url);
const HEARTBEAT_MS = 20_000;
const ROOM_ID = /^[\w-]{16,64}$/;
const CLIENT_ID = /^[\w-]{8,64}$/;

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/call.js': ['call.js', 'text/javascript; charset=utf-8'],
  '/sdp.js': ['sdp.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

const HEADERS = {
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': "default-src 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (process.env.TURN_URLS) {
    servers.push({
      urls: process.env.TURN_URLS.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

async function serveStatic(req, res) {
  const file = FILES[new URL(req.url, 'http://localhost').pathname];
  if (!file || req.method !== 'GET') {
    res.writeHead(404).end();
    return;
  }
  const [name, type] = file;
  res.writeHead(200, { ...HEADERS, 'Content-Type': type });
  res.end(await readFile(new URL(name, PUBLIC_DIR)));
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function attachSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  const rooms = new Map();

  const otherMember = (members, clientId) => {
    for (const [id, ws] of members) if (id !== clientId) return ws;
    return null;
  };

  function join(ws, { room, clientId }) {
    if (ws.room || !ROOM_ID.test(room) || !CLIENT_ID.test(clientId)) {
      ws.close(1008);
      return;
    }
    const members = rooms.get(room) ?? new Map();
    const previous = members.get(clientId);
    if (members.size >= 2 && !previous) {
      send(ws, { type: 'full' });
      ws.close();
      return;
    }
    if (previous) {
      previous.room = null;
      previous.close();
    }
    const peer = otherMember(members, clientId);
    members.set(clientId, ws);
    rooms.set(room, members);
    ws.room = room;
    ws.clientId = clientId;
    send(ws, { type: 'joined', iceServers: iceServers(), peerId: peer?.clientId ?? null });
    if (peer) send(peer, { type: 'peer-joined', peerId: clientId });
  }

  function relay(ws, data) {
    const members = rooms.get(ws.room);
    const peer = members && otherMember(members, ws.clientId);
    if (peer) send(peer, { type: 'signal', from: ws.clientId, data });
  }

  function leave(ws) {
    const members = rooms.get(ws.room);
    if (members?.get(ws.clientId) !== ws) return;
    members.delete(ws.clientId);
    if (members.size === 0) {
      rooms.delete(ws.room);
      return;
    }
    send(otherMember(members, ws.clientId), { type: 'peer-left', peerId: ws.clientId });
  }

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('close', () => leave(ws));
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        ws.close(1003);
        return;
      }
      if (message.type === 'join') join(ws, message);
      else if (message.type === 'signal' && ws.room) relay(ws, message.data);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  server.on('close', () => clearInterval(heartbeat));
  return wss;
}

export function startServer({ port = Number(process.env.PORT ?? 3000), host } = {}) {
  const server = createServer((req, res) => {
    serveStatic(req, res).catch((err) => {
      console.error(err);
      res.destroy();
    });
  });
  const wss = attachSignaling(server);
  server.on('close', () => wss.close());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  console.log(`Telão em http://localhost:${server.address().port}`);
}
