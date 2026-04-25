# Familiar Sessions

Public WebRTC signaling relay + guest entry point for [Familiar](https://github.com/seethroughlab/familiar) listening sessions.

A Familiar host (running on their NAS, laptop, etc.) opens a WebSocket to this service to **create a session**. The host shares a code with friends. Friends visit `https://<this-service>/listen/<code>` and join. The service relays SDP/ICE between peers; **audio flows peer-to-peer over WebRTC** and never touches this server.

## Why this exists

Familiar's backend usually isn't publicly reachable (typical setup: a personal NAS behind Tailscale). That's fine for the host, but their friends aren't on Tailscale. This service decouples the **signaling rendezvous** from the host's private backend so anyone with a link can join.

## Stack

- FastAPI + Uvicorn (Python 3.11+) — WebSocket signaling, ~400 LOC
- React + Vite + Tailwind (TypeScript) — standalone guest SPA, ~78 KB gzip
- Single Fly.io VM, 512 MB RAM. No database. Sessions in-memory; cap of 50 concurrent. State is lost on restart.

## Endpoints

| Path | Type | Notes |
|---|---|---|
| `/` | HTML | Splash + "enter a code" form |
| `/listen/:code` | HTML | Guest SPA route |
| `/api/v1/sessions/ws` | WebSocket | Signaling (create / join / playback / chat / kick / WebRTC SDP+ICE) |
| `/api/v1/sessions/by-code/{code}` | GET JSON | Public lookup. Returns name, participant count, `has_password`. Excludes participants and TURN credentials. |
| `/health` | GET JSON | Liveness |

See [`app/routes.py`](app/routes.py) for the full WebSocket protocol.

## Auth model

Anyone can `create` or `join_guest` — the **session code is the only credential**. Hosts can optionally set a password (bcrypt-hashed). Hosts can `kick` participants. There is no account system.

## Local dev

```bash
# backend
uv sync
uv run uvicorn app.main:app --reload --port 8000

# guest SPA (separate terminal)
cd guest
pnpm install
pnpm dev   # http://localhost:5173, proxies /api → :8000
```

For a single-process dev experience, build the guest SPA once and let FastAPI serve it:

```bash
cd guest && pnpm install && pnpm build && cd ..
uv run uvicorn app.main:app --reload --port 8000
# open http://localhost:8000
```

## Tests

```bash
uv run pytest -v
```

## TURN

Without TURN, ~30% of guests behind symmetric NAT (corporate, mobile carriers) won't connect. With Cloudflare Calls TURN (free tier), they will:

```bash
fly secrets set TURN_SERVER_URL=turn:turn.example.com:3478 \
                TURN_SERVER_USERNAME=... \
                TURN_SERVER_CREDENTIAL=... \
                -a familiar-sessions
```

## Deploy

```bash
fly launch --no-deploy   # first time only
fly deploy
```

## Familiar host integration

The Familiar frontend's `useListeningSession` hook needs to point at this service:

```bash
VITE_SESSIONS_RELAY_URL=https://familiar-sessions.fly.dev pnpm -C packages/web build
```

Hosts continue to load Familiar from their own backend; only the signaling WebSocket and the guest-facing URL come from here.
