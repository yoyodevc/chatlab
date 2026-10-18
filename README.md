# ChatLab

WebSocket chat + NGINX gateway (rate limit, v1/v2 API) + JWT auth + role-based authorization.
MIT 203 Laboratory Activity No. 4.

## Run

```bash
cp .env.example .env        # then set JWT_SECRET (openssl rand -hex 32). .env is git-ignored.
docker compose up --build
```

Open http://localhost:8080. Only the gateway (8080) is published; the app (3000) is internal.

## Seed users (lab-only passwords)

| user   | role   | password     | rooms                |
|--------|--------|--------------|----------------------|
| alice  | admin  | alice-pass-1 | all                  |
| bob    | member | bob-pass-2   | general, dev         |
| carol  | member | carol-pass-3 | general              |
| guest1 | guest  | guest-pass-4 | general (read only)  |

Passwords are stored as bcrypt hashes in `app/data.json` (regenerate with `cd app && node seed.js`).

## Layout

- `app/server.js` REST (v1, v2) + WebSocket, `auth.js` login/JWT, `authz.js` all permission rules
- `nginx/nginx.conf` gateway: routing, WS upgrade, rate limits, query-string-free access log
- `client/index.html` browser client
- `scripts/verify.js` prints observed results for the test tables (`node scripts/verify.js`)

## Manual testing

```bash
TOKEN=$(curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' \
  -d '{"username":"bob","password":"bob-pass-2"}' | jq -r .token)
curl -i -H "Authorization: Bearer $TOKEN" localhost:8080/api/v1/rooms
npx wscat -c "ws://localhost:8080/ws?token=$TOKEN"
npx wscat -c "ws://localhost:8080/ws?token=$TOKEN" -o http://evil.example   # wrong Origin
docker compose exec gateway cat /var/log/nginx/access.log
```

## Notes

- Origin check: requests with an `Origin` other than `http://localhost:8080` are rejected; clients that
  send none (wscat, curl) are allowed, since the check targets browsers.
- Tokens expiring mid-connection: the socket is closed with code 4401 (checked per message and on each heartbeat).
- NGINX error log can still show a request line with the query string when an upstream error occurs.
- Tear down when finished: `docker compose down`.
