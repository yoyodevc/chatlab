// Drives a real Edge browser through the ChatLab login page and records the WebSocket handshake
// using the Chrome DevTools Protocol Network domain (the same data DevTools shows under Network > WS > Headers).
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
  const p = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9223', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9223/json/list')).json(); if (targets.find((t) => t.type === 'page')) break; } catch {} await sleep(500); }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = {}; const out = {};
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending[m.id]) return pending[m.id](m.result);
    if (m.method === 'Network.webSocketCreated') out.url = m.params.url;
    if (m.method === 'Network.webSocketWillSendHandshakeRequest') out.request = m.params.request.headers;
    if (m.method === 'Network.webSocketHandshakeResponseReceived') out.response = m.params.response;
  };
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await cmd('Network.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: 'http://localhost:8080/' }); await sleep(2000);
  await cmd('Runtime.evaluate', { expression: "document.getElementById('user').value='bob';document.getElementById('pass').value='bob-pass-2';document.getElementById('loginBtn').click()" });
  await sleep(2500);
  out.status = (await cmd('Runtime.evaluate', { expression: "document.getElementById('log').innerText", returnByValue: true })).result.value;
  out.capturedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, '..', 'evidence', 'browser-ws-handshake.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  ws.close(); p.kill();
})();
