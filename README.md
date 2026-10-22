# Redline

Self-hosted mock-up tool for Claude Code. See `.scratch/redline/spec.md`.

## Run the server with Docker

```sh
docker compose up -d
```

- Web UI and API: `http://localhost:3000`
- Artboards are served on a separate origin: `http://localhost:3001`
- Projects, pages, versions and blobs live in the named volume `redline-data` (mounted at `/data`), so rebuilding or recreating the container keeps them. Do not run `docker compose down -v`: it deletes the volume.

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDLINE_PORT` | `3000` | Host port of the web UI and API |
| `REDLINE_ARTBOARD_PORT` | `3001` | Host port of the artboard origin |
| `REDLINE_ARTBOARD_ORIGIN` | `http://localhost:$REDLINE_ARTBOARD_PORT` | Public origin of the artboard listener; set it when behind a proxy |

### Behind a reverse proxy

Redline has no login of its own. The proxy must protect everything (web UI, API, artboard origin) except the agent endpoint `/agent` (a WebSocket on the main port), which is guarded by the agents' token. Serve the artboard port on its own host name (a different origin from the UI) and set `REDLINE_ARTBOARD_ORIGIN` to it.

## Development

```sh
npm install
npm test                # fast suite
npm run build
npm run test:docker     # opt-in: builds the image and checks data survives container recreation
```
