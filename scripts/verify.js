// Prints what ChatLab actually does for the lab's test cases (Tables 2.1, 3.1, 4.1).
// Run against the running stack:  node scripts/verify.js   (BASE=http://localhost:8080)
// Output is raw observation for YOUR evidence pack; it does not replace manual wscat/curl captures.
const WebSocket = require('../app/node_modules/ws');
const jwt = require('../app/node_modules/jsonwebtoken');

const BASE = process.env.BASE || 'http://localhost:8080';
const WS = BASE.replace(/^http/, 'ws');
const PW = { alice: 'alice-pass-1', bob: 'bob-pass-2', carol: 'carol-pass-3', guest1: 'guest-pass-4' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = (method, path, token, body) =>
  fetch(BASE + path, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });

async function login(u, p = PW[u]) {
  const r = await api('POST', '/api/v1/login', null, { username: u, password: p });
  return { status: r.status, token: r.ok ? (await r.json()).token : null };
}

// Opens a socket; resolves { ws, status, inbox } where status is 'open' or the HTTP status of the rejection.
function open(token, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/ws?token=${token}`, origin ? { origin } : undefined);
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, status: 'open', inbox }));
    ws.on('unexpected-response', (_q, res) => resolve({ ws, status: res.statusCode, inbox }));
    ws.on('error', () => {});
  });
}
const say = (c, o) => c.ws.send(JSON.stringify(o));

const rows = [];
const row = (test, observed) => { rows.push([test, observed]); console.log(`${test.padEnd(52)} ${observed}`); };

(async () => {
  console.log(`--- Table 3.1 Authentication (${BASE})`);
  const a = await login('alice'), b = await login('bob'), c = await login('carol'), g = await login('guest1');
  row('Login with correct password', a.status);
  row('Login with wrong password', (await login('alice', 'nope')).status);
  row('REST call with no token', (await api('GET', '/api/v1/rooms')).status);
  row('REST call with valid token', (await api('GET', '/api/v1/rooms', b.token)).status);
  const expired = jwt.sign({ sub: 'bob', role: 'member' }, 'x', { expiresIn: -10, issuer: 'chatlab' });
  // Signed with the wrong key on purpose: the real secret is not available here. To test a truly
  // expired token, set 15m -> 5s in auth.js temporarily, log in, wait, then call.
  row('REST call with garbage/expired-style token', (await api('GET', '/api/v1/rooms', expired)).status);
  const [h, p, s] = b.token.split('.');
  const tampered = [h, p.slice(0, -1) + (p.slice(-1) === 'A' ? 'B' : 'A'), s].join('.');
  row('REST call with tampered token', (await api('GET', '/api/v1/rooms', tampered)).status);
  row('WebSocket with no token', (await open('')).status);
  const wb = await open(b.token);
  row('WebSocket with valid token', wb.status);
  row('WebSocket from a different Origin', (await open(b.token, 'http://evil.example')).status);
  say(wb, { type: 'join', room: 'general' });
  say(wb, { type: 'message', room: 'general', text: 'spoof test', from: 'alice' });
  await sleep(300);
  row('Client sends a fake "from" field -> server stamps', wb.inbox.find((m) => m.type === 'message')?.from);

  console.log('\n--- Table 4.1 Authorization');
  const wc = await open(c.token), wg = await open(g.token), wa = await open(a.token);
  say(wc, { type: 'join', room: 'dev' });
  say(wg, { type: 'join', room: 'general' });
  say(wg, { type: 'message', room: 'general', text: 'guest talking' });
  say(wg, { type: 'join', room: 'dev' });
  say(wb, { type: 'join', room: 'dev' });
  say(wb, { type: 'message', room: 'dev', text: 'bob in dev' });
  say(wa, { type: 'join', room: 'dev' });
  await sleep(400);
  const errs = (cl) => cl.inbox.filter((m) => m.type === 'error').map((m) => m.code).join(',') || 'none';
  row('carol joins dev (expect rejected)', errs(wc));
  row('bob joins and sends in dev (expect allowed)',
    wb.inbox.some((m) => m.type === 'message' && m.room === 'dev') ? 'allowed' : 'NOT delivered');
  row('guest1 joins general + sends (errors, expect FORBIDDEN)', errs(wg));
  row('bob creates a room (expect 403)', (await api('POST', '/api/v1/rooms', b.token, { name: 'bobs' })).status);
  row('alice creates a room (expect 201)', (await api('POST', '/api/v1/rooms', a.token, { name: 'ops' })).status);
  row("bob deletes carol's msg_2 (expect 403)", (await api('DELETE', '/api/v1/messages/msg_2', b.token)).status);
  row("alice deletes carol's msg_2 (expect 200)", (await api('DELETE', '/api/v1/messages/msg_2', a.token)).status);

  const before = wb.inbox.length;
  const rem = await api('POST', '/api/v1/rooms/dev/remove', a.token, { username: 'bob' });
  say(wa, { type: 'message', room: 'dev', text: 'after removal' });
  await sleep(400);
  const got = wb.inbox.slice(before).some((m) => m.type === 'message' && m.text === 'after removal');
  row(`alice removes bob from dev (HTTP ${rem.status}); bob still receives?`, got ? 'YES (bug)' : 'no (expected)');

  console.log('\n--- Table 2.1 versioning + rate limit');
  const v1 = await api('GET', '/api/v1/rooms/general/messages', a.token);
  console.log(`v1 headers: Deprecation=${v1.headers.get('deprecation')} Sunset=${v1.headers.get('sunset')} Link=${v1.headers.get('link')}`);
  console.log('v1 body:', JSON.stringify(await v1.json()).slice(0, 160));
  console.log('v2 body:', JSON.stringify(await (await api('GET', '/api/v2/rooms/general/messages?limit=1', a.token)).json()));
  const counts = {};
  await Promise.all(Array.from({ length: 100 }, async () => {
    const r = await api('GET', '/api/v1/rooms', a.token);
    counts[r.status] = (counts[r.status] || 0) + 1;
  }));
  console.log('100 rapid requests, status counts:', counts);

  [wa, wb, wc, wg].forEach((x) => x.ws.close());
})();
