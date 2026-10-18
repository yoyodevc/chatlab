// Exercise 4 Q2: remove bob from dev while connected, then see whether he still receives / can send.
const WebSocket = require('../app/node_modules/ws');
const BASE = 'http://localhost:8080', WS = 'ws://localhost:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (u, p) => (await (await fetch(BASE + '/api/v1/login', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const open = (t) => new Promise((res) => { const ws = new WebSocket(`${WS}/ws?token=${t}`); ws.inbox = [];
  ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => res(ws)); });
(async () => {
  const at = await login('alice', 'alice-pass-1'), bt = await login('bob', 'bob-pass-2');
  const a = await open(at), b = await open(bt);
  for (const w of [a, b]) w.send(JSON.stringify({ type: 'join', room: 'dev' }));
  await sleep(300);
  const r = await fetch(BASE + '/api/v1/rooms/dev/remove', { method: 'POST',
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob' }) });
  console.log(new Date().toISOString(), 'alice removes bob from dev -> HTTP', r.status);
  const n = b.inbox.length;
  a.send(JSON.stringify({ type: 'message', room: 'dev', text: 'secret after removal' }));
  await sleep(400);
  console.log(new Date().toISOString(), 'bob received alice\'s message after removal:',
    b.inbox.slice(n).some((m) => m.text === 'secret after removal'));
  b.send(JSON.stringify({ type: 'message', room: 'dev', text: 'bob still posting' }));
  await sleep(400);
  console.log(new Date().toISOString(), 'bob\'s own message accepted and delivered to alice:',
    a.inbox.some((m) => m.text === 'bob still posting'), '| bob events after removal:', JSON.stringify(b.inbox.slice(n).map((m) => m.type + (m.code ? ':' + m.code : ''))));
  a.close(); b.close();
})();
