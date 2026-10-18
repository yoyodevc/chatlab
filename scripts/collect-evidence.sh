#!/usr/bin/env bash
# Runs every lab procedure against the live stack and saves timestamped output to evidence/.
# Usage (from repo root, Docker running):  bash scripts/collect-evidence.sh
cd "$(dirname "$0")/.." || exit 1
E=evidence; rm -rf $E; mkdir -p $E
ts() { while IFS= read -r l; do echo "$(date -u +%FT%TZ) $l"; done; }
run() { # run <file> <description> <command...>
  f=$E/$1; shift; d=$1; shift
  { echo "### $d"; echo "### cmd: $*"; "$@" 2>&1; echo "### exit: $?"; } | ts > "$f"
}
tok() { curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"$1\",\"password\":\"$2\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/'; }
wait_gw() { for i in $(seq 1 30); do curl -s -o /dev/null localhost:8080/ && return; sleep 1; done; }
up() { docker compose up -d --build >/dev/null 2>&1; docker compose restart gateway >/dev/null 2>&1; wait_gw; }

docker compose down >/dev/null 2>&1
up
BOB=$(tok bob bob-pass-2); ALICE=$(tok alice alice-pass-1)

# ---- Exercise 2
run 2-01-direct-3000.txt "Direct access to app on 3000 (expect failure)" curl -sv --max-time 5 http://localhost:3000/
run 2-02-ws-handshake.txt "WebSocket opening handshake through gateway (Q2)" \
  curl -si --max-time 3 -N http://localhost:8080/ws?token=$BOB -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: http://localhost:8080'
run 2-03-v1-headers.txt "v1 response with deprecation headers" curl -si -H "Authorization: Bearer $BOB" localhost:8080/api/v1/rooms/general/messages
run 2-04-v2.txt "v2 response" curl -si -H "Authorization: Bearer $BOB" "localhost:8080/api/v2/rooms/general/messages?limit=2"
run 2-05-rate-limit.txt "100 rapid requests (status counts)" bash -c \
  "for i in \$(seq 1 100); do curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer $ALICE' http://localhost:8080/api/v1/rooms; done | sort | uniq -c"

# WebSocket without Upgrade/Connection headers
cp nginx/nginx.conf /tmp/nginx.conf.orig
sed -i '/proxy_set_header Upgrade/d; /proxy_set_header Connection/d' nginx/nginx.conf
docker compose exec -T gateway nginx -s reload >/dev/null 2>&1; sleep 2
run 2-06-ws-without-upgrade-headers.txt "WS through gateway WITHOUT Upgrade/Connection forwarded" \
  node scripts/ws-tests.js frozen-probe-placeholder
node -e "
const W=require('./app/node_modules/ws');
const ws=new W('ws://localhost:8080/ws?token=$BOB');
ws.on('open',()=>{console.log('OPEN (unexpected)');ws.close()});
ws.on('unexpected-response',(q,r)=>console.log('REJECTED HTTP',r.statusCode,r.statusMessage));
ws.on('error',e=>console.log('ERROR',e.message));
" 2>&1 | ts > $E/2-06-ws-without-upgrade-headers.txt
docker compose logs --no-log-prefix --tail 3 gateway 2>&1 | ts >> $E/2-06-ws-without-upgrade-headers.txt
cp /tmp/nginx.conf.orig nginx/nginx.conf
docker compose exec -T gateway nginx -s reload >/dev/null 2>&1; sleep 2

# ---- Exercise 1 / 3 / 4
run 1-01-ws-tests.txt "Table 1.1 WebSocket behaviour (via gateway)" node scripts/ws-tests.js
run 3-01-verify.txt "Tables 3.1 / 4.1 / 2.1 automated checks" node scripts/verify.js
run 3-02-jwt-decode.txt "Decoded JWT (Q1)" node -e "
const t='$BOB'.split('.');const d=s=>Buffer.from(s,'base64url').toString();
console.log('header :',d(t[0]));console.log('payload:',d(t[1]));console.log('signature (b64url):',t[2]);"
run 3-03-no-token.txt "REST call with no token" curl -si localhost:8080/api/v1/rooms
run 3-04-bad-login.txt "Login with wrong password" curl -si -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' -d '{"username":"alice","password":"wrong"}'
run 3-05-ws-bad-origin.txt "WS upgrade from different Origin" curl -si --max-time 3 "http://localhost:8080/ws?token=$BOB" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: http://evil.example'
run 3-06-gateway-access-log.txt "Gateway access log (grep token= count follows)" bash -c "docker compose logs --no-log-prefix gateway | tail -40; echo; echo 'lines containing token=:' \$(docker compose logs --no-log-prefix gateway | grep -c 'token=')"
run 4-01-http-status-matrix.txt "Authorization over REST" bash -c "
echo 'bob   POST /rooms        ->' \$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $BOB' -H 'Content-Type: application/json' -d '{\"name\":\"x1\"}' localhost:8080/api/v1/rooms)
echo 'alice POST /rooms        ->' \$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $ALICE' -H 'Content-Type: application/json' -d '{\"name\":\"x1\"}' localhost:8080/api/v1/rooms)
echo 'bob   DELETE msg_2 (carol) ->' \$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H 'Authorization: Bearer $BOB' localhost:8080/api/v1/messages/msg_2)
echo 'alice DELETE msg_2 (carol) ->' \$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H 'Authorization: Bearer $ALICE' localhost:8080/api/v1/messages/msg_2)"

# ---- frozen client (default heartbeat 30 s)
run 1-02-frozen-client.txt "Frozen client: time until server closes it" node scripts/ws-tests.js frozen

# ---- idle timeout: heartbeat 120 s > proxy_read_timeout 60 s
HEARTBEAT_MS=120000 up
run 2-07-idle-ws-timeout.txt "Idle WS with heartbeat 120 s (> gateway 60 s)" node scripts/ws-tests.js idle

# ---- token expiry: TTL 5 s
HEARTBEAT_MS=30000 TOKEN_TTL=5s up
run 3-07-expired-token.txt "Token expiry (TTL=5s): REST and open WebSocket" node scripts/ws-tests.js expiry

# ---- restore defaults and tear down
HEARTBEAT_MS=30000 TOKEN_TTL=15m up
docker compose down >/dev/null 2>&1
echo "done; files in $E/"; ls $E
