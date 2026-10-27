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

Redline has no login of its own. The proxy must protect everything (web UI, API, artboard origin) except the agent endpoints `/agent` (a WebSocket on the main port) and `/agent-api/*`, which are guarded by the agents' token. The proxy must forward the original `Host` header (or `X-Forwarded-Host`): state-changing API calls are refused when their `Origin` header names another host. Serve the artboard port on its own host name (a different origin from the UI) and set `REDLINE_ARTBOARD_ORIGIN` to it. Agents upload project assets of up to 20 MB through `/agent-api/*`: raise the proxy's body size limit for that path (nginx allows 1 MB by default, `client_max_body_size`).

### Proxy secrets

Behind a proxy, Redline can refuse every request the proxy did not forward. Set both variables below (each names a file holding a random hex value of at least 32 characters; the two values must differ), otherwise no check is made:

| Variable | Secret | Accepted on |
| --- | --- | --- |
| `REDLINE_PROXY_SECRET_HUMAN_FILE` | human | UI, API and artboard origin (both listeners), except the machine paths |
| `REDLINE_PROXY_SECRET_MACHINE_FILE` | machine | `/agent`, `/agent-api/*` and `/cli/*` only |

The proxy adds the secret in the `X-Redline-Proxy-Secret` request header (its human router adds the human secret, its machine router the machine secret). Any other request gets a bare `403`. Startup fails when a secret is too short, when both are equal, or when only one file is set.

`GET /healthz` on the main port answers `200` without a secret, but only to a request whose remote address is the container's own loopback (a request through the proxy never is). The image's health check calls it.

### CLI download

The image carries the CLI as a tarball in `REDLINE_CLI_DIR` (`/app/cli`: `redline-cli.tgz` and `build-hash.txt`). The server serves it at `/cli/redline-cli.tgz` without a token (npm cannot send one; behind a proxy this is the machine route), so `npm i -g <origin>/cli/redline-cli.tgz` installs the `redline` command. `redline build-hash` prints the hash of the installed build, which equals the image's `build-hash.txt`.

### Behind Traefik (local)

With a Traefik already running on an external Docker network named `traefik` (entrypoint `web`), `docker-compose.traefik.yml` serves the UI on `http://redline.localhost` and the artboards on `http://artboards.redline.localhost`:

```sh
echo "COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml" > .env
docker compose up -d --build
redline login http://redline.localhost
```

`REDLINE_HOST_NAME` and `REDLINE_ARTBOARD_HOST` change the two host names. The loopback ports stay published, so `http://localhost:3000` keeps working.

## Development

```sh
npm install
npm test                # fast suite
npm run build
npm run test:docker     # opt-in: builds the image and checks data survives container recreation
npm run eval:agent      # opt-in, costs real Claude sessions: see below
```

### Agent eval

`npm run eval:agent` checks how a real Claude uses Redline. For each scenario of `scripts/eval-scenarios/*.md` (a request written like a user's), it runs a headless `claude -p` with only the Redline MCP (`redline mcp`, from `packages/agent/dist`: run `npm run build` first) in a folder linked to a fresh project of a throwaway server. Then it opens every page the session made and checks, on the real canvas: refused Redline calls, design system gaps, overlapping boxes, elements over artboards, arrows crossing a box, cut titles and empty artboards. The report (`report.html`, screenshots and transcripts) lands in `.scratch/eval-runs/<date>/`. Each scenario costs one real session (about $0.60 with the default model). Flags: `--scenario <name>` (repeatable), `--model <model>`, `--budget <usd>` (per scenario, default 3), `--keep` (leave the server running to look at the pages).
