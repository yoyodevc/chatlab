const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const state = require('./state');
const { login, verify, requireAuth } = require('./auth');
const { can } = require('./authz');

const PORT = 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:8080';
const MAX_RAW_BYTES = 4096;
const MAX_TEXT_CHARS = 500;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 30000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

const wsRooms = new Map(); // room name -> Set<socket>

/* ------------------------------------------------------------------ REST */

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(process.env.CLIENT_DIR || path.join(__dirname, '..', 'client')));

const v1 = express.Router();
const v2 = express.Router();

// v1 is deprecated: announce it on every response.
v1.use((req, res, next) => {
  res.set({
    Deprecation: 'true',
    Sunset: 'Wed, 30 Jun 2027 00:00:00 GMT',
    Link: '</api/v2/rooms>; rel="successor-version"',
  });
  next();
});

v1.post('/login', login);

v1.get('/rooms', requireAuth, (req, res) => {
  res.json(Object.keys(state.rooms).filter((r) => can(req.user, 'join', r)));
});

v1.post('/rooms', requireAuth, (req, res) => {
  if (!can(req.user, 'create')) return res.status(403).json({ error: 'Forbidden' });
  const name = req.body && req.body.name;
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,32}$/.test(name)) {
    return res.status(400).json({ error: 'name must match [a-z0-9-]{1,32}' });
  }
  if (state.rooms[name]) return res.status(409).json({ error: 'Room exists' });
  state.rooms[name] = { members: [req.user.sub] };
  res.status(201).json({ room: name });
});

// Shared by v1 and v2: returns the room's messages, or sends 404/403 and returns null.
function readableMessages(req, res) {
  const room = req.params.room;
  if (!state.rooms[room]) {
    res.status(404).json({ error: 'No such room' });
    return null;
  }
  if (!can(req.user, 'join', room)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return state.messages.filter((m) => m.room === room);
}

v1.get('/rooms/:room/messages', requireAuth, (req, res) => {
  const list = readableMessages(req, res);
  if (!list) return;
  res.json(list.map((m) => ({ id: m.id, from: m.from, text: m.text, ts: m.ts })));
});

v2.get('/rooms/:room/messages', requireAuth, (req, res) => {
  const list = readableMessages(req, res);
  if (!list) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  let start = 0;
  if (req.query.cursor) {
    const idx = list.findIndex((m) => m.id === req.query.cursor);
    if (idx === -1) return res.status(400).json({ error: 'Bad cursor' });
    start = idx + 1;
  }
  const page = list.slice(start, start + limit);
  const roleOf = (u) => (state.users.find((x) => x.username === u) || {}).role || 'unknown';
  res.json({
    items: page.map((m) => ({
      id: m.id,
      from: { username: m.from, role: roleOf(m.from) },
      text: m.text,
      ts: m.ts,
    })),
    nextCursor: start + limit < list.length ? page[page.length - 1].id : null,
  });
});

v1.delete('/messages/:id', requireAuth, (req, res) => {
  const idx = state.messages.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No such message' });
  const msg = state.messages[idx];
  if (!can(req.user, 'delete', msg.room, msg)) return res.status(403).json({ error: 'Forbidden' });
  state.messages.splice(idx, 1);
  broadcast(msg.room, { type: 'deleted', room: msg.room, id: msg.id });
  res.json({ deleted: msg.id });
});

v1.post('/rooms/:room/remove', requireAuth, (req, res) => {
  if (!can(req.user, 'remove', req.params.room)) return res.status(403).json({ error: 'Forbidden' });
  const name = req.params.room;
  const room = state.rooms[name];
  if (!room) return res.status(404).json({ error: 'No such room' });
  const username = req.body && req.body.username;
  if (typeof username !== 'string') return res.status(400).json({ error: 'username required' });
  room.members = room.members.filter((m) => m !== username);
  // Take their open sockets out of the room right now.
  for (const ws of [...(wsRooms.get(name) || [])]) {
    if (ws.user.sub === username) {
      wsRooms.get(name).delete(ws);
      send(ws, { type: 'removed', room: name });
    }
  }
  res.json({ removed: username, room: name });
});

app.use('/api/v1', v1);
app.use('/api/v2', v2);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ------------------------------------------------------------- WebSocket */

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function sendError(ws, code, detail) {
  send(ws, { type: 'error', code, detail });
}

// Deliver to everyone in the room (sender included). Permission is re-checked per
// recipient so a member removed from the room never receives another message.
function broadcast(room, payload) {
  const set = wsRooms.get(room);
  if (!set) return;
  for (const ws of [...set]) {
    if (can(ws.user, 'join', room)) send(ws, payload);
    else set.delete(ws);
  }
}

function handleMessage(ws, raw) {
  if (ws.user.exp * 1000 < Date.now()) return ws.close(4401, 'token expired');
  if (raw.length > MAX_RAW_BYTES) return sendError(ws, 'TOO_LARGE', `max ${MAX_RAW_BYTES} bytes`);

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return sendError(ws, 'BAD_FORMAT', 'invalid JSON');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
    return sendError(ws, 'BAD_FORMAT', 'type is required');
  }
  if (!['join', 'message', 'leave'].includes(msg.type)) {
    return sendError(ws, 'UNKNOWN_TYPE', `unknown type "${msg.type}"`);
  }
  if (typeof msg.room !== 'string' || !state.rooms[msg.room]) {
    return sendError(ws, 'NO_SUCH_ROOM', 'room does not exist');
  }
  const room = msg.room;

  if (msg.type === 'join') {
    if (!can(ws.user, 'join', room)) return sendError(ws, 'FORBIDDEN', 'not allowed to join this room');
    if (!wsRooms.has(room)) wsRooms.set(room, new Set());
    wsRooms.get(room).add(ws);
    return send(ws, { type: 'joined', room });
  }

  if (msg.type === 'leave') {
    wsRooms.get(room)?.delete(ws);
    return send(ws, { type: 'left', room });
  }

  // type === 'message'
  if (!wsRooms.get(room)?.has(ws)) return sendError(ws, 'NOT_IN_ROOM', 'join the room first');
  if (!can(ws.user, 'send', room)) return sendError(ws, 'FORBIDDEN', 'not allowed to send in this room');
  if (typeof msg.text !== 'string' || msg.text.length === 0) {
    return sendError(ws, 'BAD_FORMAT', 'text is required');
  }
  if (msg.text.length > MAX_TEXT_CHARS) {
    return sendError(ws, 'TOO_LONG', `text max ${MAX_TEXT_CHARS} characters`);
  }
  const out = {
    id: `msg_${state.nextId++}`,
    room,
    from: ws.user.sub, // always the verified identity; a client-supplied "from" is ignored
    text: msg.text,
    ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  state.messages.push(out);
  broadcast(room, { type: 'message', ...out });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    try {
      handleMessage(ws, raw);
    } catch (err) {
      console.error('handler error', err);
      sendError(ws, 'INTERNAL', 'internal error');
    }
  });
  ws.on('close', () => {
    for (const set of wsRooms.values()) set.delete(ws);
  });
  ws.on('error', () => {});
});

server.on('upgrade', (req, socket, head) => {
  const reject = (status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return reject('404 Not Found');

  // Browsers always send Origin; reject cross-site pages. Non-browser tools (wscat) send none.
  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) return reject('403 Forbidden');

  let user;
  try {
    user = verify(url.searchParams.get('token') || '');
  } catch {
    return reject('401 Unauthorized');
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    wss.emit('connection', ws, req);
  });
});

// Heartbeat: ping every 30 s; drop sockets that missed the last ping or whose token expired.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    if (ws.user.exp * 1000 < Date.now()) return ws.close(4401, 'token expired');
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

server.listen(PORT, () => console.log(`ChatLab listening on ${PORT}`));
