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

## Install on a server

Redline runs on a host that already has Traefik and an SSO (Authelia, Authentik, Keycloak through oauth2-proxy...). Redline has no login: Traefik asks your SSO first, then adds a secret header that Redline requires. Only the agents' paths (`/agent`, `/agent-api/*`) and the CLI download (`/cli/*`) skip the SSO; they are guarded by the agents' token and carry a second secret.

### Preflight

- Docker with Compose v2.20 or later (`docker compose version`).
- Traefik runs with the Docker provider, on a Docker network Redline can join (default name `traefik`). Check its names: entrypoints (`web`, `websecure`), certificate resolver, and the SSO middleware (the Traefik dashboard lists middlewares as `<name>@<provider>`).
- Traefik forwards the original `Host` header (the default). If Traefik is itself behind another proxy, trust its forwarded headers.
- Two DNS names point to the server: one for the UI and API, one for the artboards (a different origin on purpose). The certificate resolver must be able to issue both.
- The Traefik names Redline creates are unique: they all start with `REDLINE_TRAEFIK_PREFIX` (default `redline`). Change it if another project uses it.

### First install

```sh
git clone <repository> redline && cd redline
cp .env.dist .env
$EDITOR .env                  # fill the REQUIRED lines, check the Traefik and identity header names
scripts/generate-secrets.sh   # creates ./secrets/* and the two REDLINE_PROXY_SECRET_* lines of .env
docker compose up -d --build
```

`docker compose` refuses to start while `REDLINE_UI_HOST`, `REDLINE_ARTBOARD_HOST`, `REDLINE_AUTH_MIDDLEWARE` or a proxy secret is missing. The generator creates the missing secret files and `.env` lines, and never overwrites one that exists. The container publishes no port, runs as uid 1000 with a read-only root, no capability and `no-new-privileges`, and is limited to 1 GB of memory and 256 processes. Open `https://<UI host>`: the SSO asks you to sign in, then the machine setup command is shown on the Agents screen.

Agent sessions connect through `https://<UI host>` (`npm i -g https://<UI host>/cli/redline-cli.tgz && redline setup https://<UI host> --token <token>`); the machine route is rate limited and asset uploads of 20 MB pass its body limit.

### Plug your SSO

The SSO middleware named in `REDLINE_AUTH_MIDDLEWARE` must protect both host names, and must not apply to the machine paths (Redline's machine router never uses it).

- **Authelia**: a `forwardAuth` middleware (`authelia@docker`, or the name you gave it). Add an access rule for both hosts and a group:

  ```yaml
  access_control:
    rules:
      - domain: ["redline.example.com", "artboards.redline.example.com"]
        policy: one_factor
        subject: ["group:redline"]
  ```

- **Authentik**: create a proxy provider in forward-auth (domain level) mode for both hosts, attach it to the embedded outpost, and use the `forwardAuth` middleware pointing at the outpost (`/outpost.goauthentik.io/auth/traefik`) with `authResponseHeaders` listing the headers below.
- **Keycloak**: Keycloak does not do forward auth by itself: run oauth2-proxy (`--reverse-proxy --set-xauthrequest --upstream=static://202`) with your Keycloak client, expose it as a `forwardAuth` middleware on `/oauth2/auth`, and list the headers below in `authResponseHeaders`.

### Identity headers

The SSO middleware must pass the signed-in person to Redline in request headers. Set their names in `.env`:

| SSO | `REDLINE_IDENTITY_HEADER_USER` | `REDLINE_IDENTITY_HEADER_NAME` | `REDLINE_IDENTITY_HEADER_EMAIL` | `REDLINE_LOGOUT_URL` |
| --- | --- | --- | --- | --- |
| Authelia (default) | `Remote-User` | `Remote-Name` | `Remote-Email` | `https://<auth host>/logout` |
| Authentik | `X-authentik-username` | `X-authentik-name` | `X-authentik-email` | `https://<authentik host>/outpost.goauthentik.io/sign_out` |
| oauth2-proxy (Keycloak) | `X-Auth-Request-User` | `X-Auth-Request-Preferred-Username` | `X-Auth-Request-Email` | `https://<UI host>/oauth2/sign_out` |

The middleware must list the same names in `authResponseHeaders`. Redline reads them only on requests that carry the human proxy secret, and the machine router empties them.

### Upgrade

```sh
git pull
docker compose up -d --build
```

The data volume `redline_redline-data` is kept. Never run `docker compose down -v`: it deletes the volume.

### Secret rotation

The two proxy secrets live twice: in `./secrets/` (read by Redline) and in `.env` (read by Traefik labels). To rotate one:

```sh
rm secrets/proxy-secret-human                    # or proxy-secret-machine
sed -i '/^REDLINE_PROXY_SECRET_HUMAN=/d' .env    # the matching line
scripts/generate-secrets.sh
docker compose up -d --force-recreate
```

The generator refuses a `.env` value that differs from its file, so the two copies cannot drift. The recreation applies the new value to Traefik and Redline together. The agents' token is separate: regenerate it from the Agents screen.

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
