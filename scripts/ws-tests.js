// Measurements for Table 1.1 (WebSocket behaviour). Usage: node scripts/ws-tests.js [frozen|idle|expiry]
//   (no arg) delivery, isolation, bad input, size, latency
//   frozen   client that never answers pings: seconds until the server closes it
//   idle     authenticated but silent client that answers pings: seconds until it is closed
//   expiry   needs TOKEN_TTL=5s on the stack: connection/REST behaviour after the token expires
const WebSocket = require('../app/node_modules/ws');
const BASE = process.env.BASE || 'http://localhost:8080';
const WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const log = (...a) => console.log(stamp(), ...a);

async function token(u, p) {
  const r = await fetch(`${BASE}/api/v1/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  return (await r.json()).token;
}
function open(tok, opts) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WS}/ws?token=${tok}`, opts);
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push({ t: Date.now(), m: JSON.parse(d) }));
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
const tx = (ws, o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
const codes = (ws) => ws.inbox.filter((x) => x.m.type === 'error').map((x) => x.m.code);

async function main() {
  const mode = process.argv[2];
  const bobTok = await token('bob', 'bob-pass-2');

  if (mode === 'frozen') {
    const ws = await open(bobTok, { autoPong: false }); // simulates Ctrl+Z: socket alive, never pongs
    const t0 = Date.now();
    log('frozen client connected (autoPong disabled)');
    await new Promise((r) => ws.on('close', (code) => { log(`closed by server, code=${code}`); r(); }));
    log(`RESULT frozen client closed after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return;
  }
  if (mode === 'idle') {
    const ws = await open(bobTok);
    const t0 = Date.now();
    log('idle client connected (answers pings, sends nothing)');
    await new Promise((r) => ws.on('close', (code) => { log(`closed, code=${code}`); r(); }));
    log(`RESULT idle WebSocket closed after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return;
  }
  if (mode === 'expiry') {
    const ws = await open(bobTok);
    tx(ws, { type: 'join', room: 'general' });
    await sleep(7000);
    const r = await fetch(`${BASE}/api/v1/rooms`, { headers: { Authorization: `Bearer ${bobTok}` } });
    log(`REST with expired token -> ${r.status}`);
    const closed = new Promise((res) => ws.on('close', (c) => res(c)));
    tx(ws, { type: 'message', room: 'general', text: 'after expiry' });
    log('WS close code after sending with expired token:', await closed);
    return;
  }

  // ---- default: Table 1.1
  const carolTok = await token('carol', 'carol-pass-3');
  const aliceTok = await token('alice', 'alice-pass-1');
  const [a, b, c] = [await open(aliceTok), await open(bobTok), await open(carolTok)];
  const other = await open(aliceTok);
  [a, b, c].forEach((w) => tx(w, { type: 'join', room: 'general' }));
  tx(other, { type: 'join', room: 'dev' });
  await sleep(300);

  tx(b, { type: 'message', room: 'general', text: 'hello room' });
  await sleep(300);
  const got = (w) => w.inbox.some((x) => x.m.type === 'message' && x.m.text === 'hello room');
  log(`RESULT 3 clients in general received: alice=${got(a)} bob(sender)=${got(b)} carol=${got(c)}`);
  log(`RESULT client in different room (dev) received: ${got(other)}`);

  const n0 = b.inbox.length;
  tx(b, '{not json');
  tx(b, { type: 'shout', room: 'general' });
  tx(b, { text: 'no type' });
  tx(b, { type: 'message', room: 'general', text: 'x'.repeat(5000) });
  tx(b, { type: 'message', room: 'general', text: 'y'.repeat(501) });
  await sleep(400);
  log('RESULT errors returned for [invalid JSON, unknown type, missing type, 5KB, 501 chars]:',
    JSON.stringify(b.inbox.slice(n0).filter((x) => x.m.type === 'error').map((x) => x.m.code)));
  tx(b, { type: 'message', room: 'general', text: 'still alive?' });
  await sleep(300);
  log('RESULT server still delivering after bad input:',
    b.inbox.some((x) => x.m.text === 'still alive?'), '| bob socket state:', b.readyState === WebSocket.OPEN ? 'open' : 'closed');

  // latency: send -> own echo, 20 messages
  const lat = [];
  for (let i = 0; i < 20; i++) {
    const text = `lat-${i}`; const t = Date.now();
    tx(b, { type: 'message', room: 'general', text });
    await new Promise((res) => {
      const iv = setInterval(() => {
        const hit = b.inbox.find((x) => x.m.text === text);
        if (hit) { lat.push(hit.t - t); clearInterval(iv); res(); }
      }, 1);
    });
    await sleep(30);
  }
  const avg = lat.reduce((s, x) => s + x, 0) / lat.length;
  log(`RESULT avg send->receive over 20 msgs: ${avg.toFixed(1)} ms (min ${Math.min(...lat)}, max ${Math.max(...lat)}) via ${WS}`);
  [a, b, c, other].forEach((w) => w.close());
}
main().catch((e) => { console.error(e); process.exit(1); });
