# Redline

Self-hosted mock-up tool for Claude Code. See `.scratch/redline/spec.md`.

## Run the server with Docker

```sh
docker compose up -d
```

- Web UI and API: `http://localhost:3000` (the ports are published on `127.0.0.1` only, see "Exposing the server")
- Artboards are served on a separate origin: `http://localhost:3001`
- Projects, pages, versions and blobs live in the named volume `redline-data` (mounted at `/data`), so rebuilding or recreating the container keeps them. Do not run `docker compose down -v`: it deletes the volume.

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDLINE_BIND` | `127.0.0.1` | Host address the two ports are published on |
| `REDLINE_PORT` | `3000` | Host port of the web UI and API |
| `REDLINE_ARTBOARD_PORT` | `3001` | Host port of the artboard origin |
| `REDLINE_ARTBOARD_ORIGIN` | `http://localhost:$REDLINE_ARTBOARD_PORT` | Public origin of the artboard listener; set it when behind a proxy |

### Limits

- Project assets (images, fonts) uploaded from the DESIGN.md screen: 20 MB each. Every other request body: 1 MB.
- Data (SQLite database and blobs) has no quota; watch the volume if you upload large assets.

### Exposing the server

Redline has no login, and `GET /api/agent-token` hands out the agents' token to whoever reaches the API. That is why `docker-compose.yml` publishes both ports on `127.0.0.1` by default. To use Redline from other machines, keep the default and put a reverse proxy on the same host (it reaches `127.0.0.1:3000` and `127.0.0.1:3001`) that authenticates users. Set `REDLINE_BIND=0.0.0.0` only on a network where everyone who can connect may administer Redline.

### Behind a reverse proxy

Redline has no login of its own. The proxy must protect everything (web UI, API, artboard origin) except the agent endpoints `/agent` (a WebSocket on the main port) and `/agent-api/*`, which are guarded by the agents' token. The proxy must forward the original `Host` header (or `X-Forwarded-Host`): state-changing API calls are refused when their `Origin` header names another host. Serve the artboard port on its own host name (a different origin from the UI) and set `REDLINE_ARTBOARD_ORIGIN` to it.

## Development

```sh
npm install
npm test                # fast suite
npm run build
npm run test:docker     # opt-in: builds the image and checks data survives container recreation
```
