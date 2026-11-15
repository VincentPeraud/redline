# Redline

Self-hosted mock-up tool for Claude Code.

Claude Code draws screens as HTML artboards through Redline's MCP server; people review them on a shared canvas, leave comments pinned to an artboard, and Claude answers and revises. Projects, pages, versions and design systems live on your own server.

Licensed under the [MIT License](LICENSE).

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
| `REDLINE_AUTH_MODE` | `local` | How people sign in: `local`, `proxy` or `none`, see "Sign-in modes" |
| `REDLINE_FIRST_ADMIN_EMAIL` | none | `proxy` mode only, required: the e-mail of the SSO person who becomes the first admin |
| `REDLINE_TRUSTED_PROXY` | off | `1` or `true` behind a reverse proxy that sets `X-Forwarded-For`: the sign-in lockout then counts the address it reports; never set it when clients reach Redline directly |
| `REDLINE_PUBLIC_URL` | `http://localhost:$REDLINE_PORT` | Address people open; used in the setup link and by `reset-admin` |
| `REDLINE_BIND` | `127.0.0.1` | Host address the two ports are published on |
| `REDLINE_PORT` | `3000` | Host port of the web UI and API |
| `REDLINE_ARTBOARD_PORT` | `3001` | Host port of the artboard origin |
| `REDLINE_ARTBOARD_ORIGIN` | `http://localhost:$REDLINE_ARTBOARD_PORT` | Public origin of the artboard listener; set it when behind a proxy |
| `REDLINE_PUBLIC_UNTIL` | unset | ISO date after which requests whose `Host` is not a local name (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) are refused, see "Sharing through a tunnel" |

### Limits

- Project assets (images, fonts) uploaded from the DESIGN.md screen: 20 MB each. Every other request body: 1 MB.
- Data (SQLite database and blobs) has no quota; watch the volume if you upload large assets.

### Exposing the server

In `none` mode Redline has no login, and anyone who reaches the API can administer it. In the default `local` mode people sign in with an account, but `docker-compose.yml` still publishes both ports on `127.0.0.1` by default. To use Redline from other machines, keep the default and put a reverse proxy on the same host (it reaches `127.0.0.1:3000` and `127.0.0.1:3001`) that authenticates users. Set `REDLINE_BIND=0.0.0.0` only on a network you trust, and set `REDLINE_PUBLIC_URL` to the address people open. Mode `none` refuses to start when `REDLINE_PUBLIC_URL` names a host that is not local.

### Sign-in modes

`REDLINE_AUTH_MODE` selects one of three modes (without it, Redline runs in `proxy` when the proxy secrets are set, otherwise in `local`):

| Mode | Who signs people in | Use |
| --- | --- | --- |
| `local` | Redline: e-mail and password, invitation links | Default of `docker-compose.yml` |
| `proxy` | Your SSO through the reverse proxy; Redline keeps its own list of accounts | Server install (`docker-compose.production.yml` sets it) |
| `none` | Nobody: no identity, everything allowed | Development and tests only |

**Setup link (`local`).** While no account exists, the container logs write `No account yet. Open this link to create the first admin: <REDLINE_PUBLIC_URL>/#/setup/<token>`. Read it with `docker compose logs redline`, open it and choose a name, e-mail and password. Set `REDLINE_PUBLIC_URL` to the address people really open, otherwise the link names `localhost`. Admins then invite members from "Comptes" (a link to copy, no e-mail is sent).

**Lost password (`local`).** `docker compose exec redline redline-server reset-admin` writes a single-use password link (valid 24 hours) for the oldest active admin to its output.

**First admin (`proxy`).** There is no setup link: set `REDLINE_FIRST_ADMIN_EMAIL` (Redline refuses to start without it); on an instance with no account, the SSO person with that e-mail becomes admin and receives the existing projects if there are any, and anyone else gets the no-access screen. **The e-mails your SSO sends must be set by the SSO's admin, not by the users themselves** (true for Authelia's file backend): Redline matches people by e-mail, so a user who could choose their e-mail could take over an account. People seen before the update get the no-access screen until an admin adds them in "Comptes". `reset-admin` is a `local` command.

**Moving from `local` to `proxy`.** Set `REDLINE_AUTH_MODE=proxy` (and the proxy secrets, see below). At their first SSO sign-in, accounts are matched by e-mail and keep their role, projects, links and agent token, so the SSO must send the same e-mails the accounts use. Accounts not matched yet stay listed; admins deactivate the ones that left.

**Share links.** A share link (`/s/<token>`) is for someone with no account. In `proxy` mode your proxy must not ask the SSO for `/s/*` (nor for `/assets/`, the app bundle the link loads); Redline only serves such a request its link's scope. The artboard origin needs no SSO either: each artboard URL carries a signed viewing capability (`/c/<capability>/...`) valid 10 minutes, and its key is kept in the data folder (`artboard-capability.key`). `docker-compose.production.yml` configures both routers.

**Old shared agent token.** The single agent token of before the accounts becomes the first admin's own token, and Redline logs a line when it migrates. If other machines still used it, regenerate it from the Agents page and set those machines up again.

**Stored tokens.** Share link tokens and agent tokens are stored readable in the SQLite database (so a link can be copied again), and so are in its backups. The database, the data volume and its backups are the trust boundary: keep them as private as the server.

### Behind a reverse proxy

In `proxy` mode the SSO must protect the web UI and API. It must not protect the agent endpoints `/agent` (a WebSocket on the main port) and `/agent-api/*`, which are guarded by the agents' token, nor the share links and artboard origin described above. The proxy must forward the original `Host` header (or `X-Forwarded-Host`): state-changing API calls are refused when their `Origin` header names another host. Serve the artboard port on its own host name (a different origin from the UI) and set `REDLINE_ARTBOARD_ORIGIN` to it. Agents upload project assets of up to 20 MB through `/agent-api/*`: raise the proxy's body size limit for that path (nginx allows 1 MB by default, `client_max_body_size`).

### Proxy secrets

Behind a proxy, Redline can refuse every request the proxy did not forward. Set both variables below (each names a file holding a random hex value of at least 32 characters; the two values must differ), otherwise no check is made:

| Variable | Secret | Accepted on |
| --- | --- | --- |
| `REDLINE_PROXY_SECRET_HUMAN_FILE` | human | UI, API and artboard origin (both listeners), except the machine paths |
| `REDLINE_PROXY_SECRET_MACHINE_FILE` | machine | `/agent`, `/agent-api/*` and `/cli/*` only |

The proxy adds the secret in the `X-Redline-Proxy-Secret` request header (its human router adds the human secret, its machine router the machine secret). Any other request gets a bare `403`. Startup fails when a secret is too short, when both are equal, or when only one file is set.

`GET /healthz` on the main port answers `200` without a secret, but only to a request whose remote address is the container's own loopback (a request through the proxy never is). The image's health check calls it.

### Signed-in person (SSO)

When the proxy secrets are set, Redline reads who is signed in from the identity headers your SSO adds, on `/api` requests carrying the human secret only (never on the machine paths, never when no proxy secrets are set: without them anyone could forge the headers, so there is then no identity, no account block and no menu). A person who is on the accounts list (or the first to arrive) signs in with it, and their name and e-mail follow the SSO. `GET /api/me` answers the person and the logout URL, or `null`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDLINE_IDENTITY_HEADER_USER` | `Remote-User` | Header holding the user id |
| `REDLINE_IDENTITY_HEADER_NAME` | `Remote-Name` | Header holding the display name |
| `REDLINE_IDENTITY_HEADER_EMAIL` | `Remote-Email` | Header holding the e-mail |
| `REDLINE_LOGOUT_URL` | none | Where "Se déconnecter" leads (the SSO's logout page); without it the menu offers no sign-out |

The defaults are Authelia's. oauth2-proxy sends `X-Auth-Request-User`, `X-Auth-Request-Preferred-Username` (or `X-Auth-Request-Email`) and `X-Auth-Request-Email`; Authentik sends `X-authentik-username`, `X-authentik-name` and `X-authentik-email`. Your proxy must forward these headers to Redline.

### CLI download

The image carries the CLI as a tarball in `REDLINE_CLI_DIR` (`/app/cli`: `redline-cli.tgz` and `build-hash.txt`). The server serves it at `/cli/redline-cli.tgz` without a token (npm cannot send one; behind a proxy this is the machine route), so `npm i -g <origin>/cli/redline-cli.tgz` installs the `redline` command. Then `redline setup <origin> --token <token>` (the Agents screen shows the full command) checks the token, stores the server and registers the Redline MCP in Claude Code at user scope. Run it again with another URL to set up several servers; a folder remembers its server, and `redline agent --global` needs `--server <url>` when there are several. `http://` is accepted only for `localhost`, `*.localhost` and `127.0.0.1`. `redline build-hash` prints the hash of the installed build, which equals the image's `build-hash.txt`.

### Sharing through a tunnel

To show your local Redline to someone for a while (a Cloudflare quick tunnel, for example), open one tunnel per port, set `REDLINE_ARTBOARD_ORIGIN` to the artboard tunnel's address and `REDLINE_PUBLIC_UNTIL` to the end of the share, then recreate the container:

```sh
cloudflared tunnel --url http://127.0.0.1:3000   # UI and API
cloudflared tunnel --url http://127.0.0.1:3001   # artboards
REDLINE_ARTBOARD_ORIGIN=https://<artboard tunnel> REDLINE_PUBLIC_UNTIL=2026-11-01T13:39:00+01:00 docker compose up -d
```

Whoever has the link administers everything: Redline has no login, and the tunnel reaches every project and the agents' token. After the deadline, each request that does not name a local host is refused (403) and the connections public hosts opened are closed within a minute, even if the tunnel keeps running; `localhost` and `*.localhost` keep working. The tunnel must keep the visitor's `Host` (cloudflared does by default): only that header is read, never `X-Forwarded-Host`. Stop the tunnels and run `docker compose up -d` without the two variables to end the share.

### Behind Traefik (local)

With a Traefik already running on an external Docker network named `traefik` (entrypoint `web`), `docker-compose.traefik.yml` serves the UI on `http://redline.localhost` and the artboards on `http://artboards.redline.localhost`:

```sh
echo "COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml" > .env
docker compose up -d --build
redline setup http://redline.localhost --token <token>
```

`REDLINE_HOST_NAME` and `REDLINE_ARTBOARD_HOST` change the two host names. The loopback ports stay published, so `http://localhost:3000` keeps working.

## Install on a server

Redline runs on a host that already has Traefik and an SSO (Authelia, Authentik, Keycloak through oauth2-proxy...). Redline runs in `proxy` mode: Traefik asks your SSO first, then adds a secret header that Redline requires, and Redline keeps its own list of accounts (the first person to sign in becomes admin). Three groups of paths skip the SSO: the agents' paths (`/agent`, `/agent-api/*`) and the CLI download (`/cli/*`), guarded by the agents' token with a second secret; share links (`/s/*`, plus the app bundle under `/assets/`), served only their link's scope; and the artboard origin, guarded by the viewing capability in each URL. The last two carry the human secret.

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

`docker compose` refuses to start while `REDLINE_UI_HOST`, `REDLINE_ARTBOARD_HOST`, `REDLINE_AUTH_MIDDLEWARE`, `REDLINE_FIRST_ADMIN_EMAIL` or a proxy secret is missing. The generator creates the missing secret files and `.env` lines, and never overwrites one that exists. The container publishes no port, runs as uid 1000 with a read-only root, no capability and `no-new-privileges`, and is limited to 1 GB of memory and 256 processes. Open `https://<UI host>`: the SSO asks you to sign in, then the machine setup command is shown on the Agents screen.

Agent sessions connect through `https://<UI host>` (`npm i -g https://<UI host>/cli/redline-cli.tgz && redline setup https://<UI host> --token <token>`); the machine route is rate limited and asset uploads of 20 MB pass its body limit.

### Plug your SSO

The SSO middleware named in `REDLINE_AUTH_MIDDLEWARE` protects the UI host only. Redline's machine, share and artboard routers never use it. Reset a lost admin with the SSO itself: there is no password in `proxy` mode.

- **Authelia**: a `forwardAuth` middleware (`authelia@docker`, or the name you gave it). Add an access rule for the UI host and a group:

  ```yaml
  access_control:
    rules:
      - domain: ["redline.example.com"]
        policy: one_factor
        subject: ["group:redline"]
  ```

- **Authentik**: create a proxy provider in forward-auth (domain level) mode for the UI host, attach it to the embedded outpost, and use the `forwardAuth` middleware pointing at the outpost (`/outpost.goauthentik.io/auth/traefik`) with `authResponseHeaders` listing the headers below.
- **Keycloak**: Keycloak does not do forward auth by itself: run oauth2-proxy (`--reverse-proxy --set-xauthrequest --upstream=static://202`) with your Keycloak client, expose it as a `forwardAuth` middleware on `/oauth2/auth`, and list the headers below in `authResponseHeaders`.

### Identity headers

The SSO middleware must pass the signed-in person to Redline in request headers. Set their names in `.env`:

| SSO | `REDLINE_IDENTITY_HEADER_USER` | `REDLINE_IDENTITY_HEADER_NAME` | `REDLINE_IDENTITY_HEADER_EMAIL` | `REDLINE_LOGOUT_URL` |
| --- | --- | --- | --- | --- |
| Authelia (default) | `Remote-User` | `Remote-Name` | `Remote-Email` | `https://<auth host>/logout` |
| Authentik | `X-authentik-username` | `X-authentik-name` | `X-authentik-email` | `https://<authentik host>/outpost.goauthentik.io/sign_out` |
| oauth2-proxy (Keycloak) | `X-Auth-Request-User` | `X-Auth-Request-Preferred-Username` | `X-Auth-Request-Email` | `https://<UI host>/oauth2/sign_out` |

The middleware must list the same names in `authResponseHeaders`. Redline empties the three identity headers before the SSO runs (the `strip-identity` middleware, ahead of `REDLINE_AUTH_MIDDLEWARE` on both human routers), so a signed-in person cannot forge them: the SSO only overwrites the headers it lists. Redline reads them only on requests that carry the human proxy secret, and the machine router empties them too.

Keep the Traefik dashboard and API closed (no `--api.insecure`, not exposed on a public router): the proxy secrets are in the router labels and the dashboard would show them.

### Upgrade

```sh
git pull --ff-only
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

### Backup

`scripts/backup.sh` backs the server up with [restic](https://restic.net) (run from a digest-pinned image, so the host needs only Docker). It:

1. makes a consistent copy of the SQLite database inside the container (SQLite's backup API on a read-only connection) and checks it (`integrity_check`, the expected tables, the project count): a copy that fails stops the backup before restic runs;
2. backs that copy and the `blobs` folder up to your restic repository (the data volume is mounted read-only; the repository is created on the first run);
3. keeps 7 daily, 4 weekly and 6 monthly snapshots (`forget --prune`), and on Sundays runs `check --read-data-subset=5%`.

The settings live in a folder outside git, `~/.config/redline-backup` by default (`REDLINE_BACKUP_CONFIG_DIR` changes it). Keep it private: the script refuses to run when the folder or a file in it is readable by group or others.

```sh
mkdir -p ~/.config/redline-backup && chmod 700 ~/.config/redline-backup && cd ~/.config/redline-backup
echo 'sftp:backup@storage.example.com:/redline' > repository   # see below
openssl rand -base64 32 > password                              # also keep a copy of it elsewhere: without it the backups are unreadable
chmod 600 *
```

| File | |
| --- | --- |
| `repository` | required: `sftp:user@host:/path`, `s3:s3.amazonaws.com/bucket`, an absolute folder of the host, or `volume:<docker volume>` |
| `password` | required: the restic repository password |
| `env` | `KEY=VALUE` lines for the repository (S3: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) |
| `ssh-key`, `known_hosts` | for an SFTP repository: the private key and the server's host key (`ssh-keyscan storage.example.com > known_hosts`); with a `known_hosts` the host key is checked strictly |
| `webhook-success`, `webhook-failure` | a URL each (Mattermost, Slack...): the script posts `{"text": "..."}` after a successful or failed backup |

Run it once by hand (`scripts/backup.sh`), then from the host's cron:

```
30 3 * * * /path/to/redline/scripts/backup.sh
```

Logs are kept in `<settings folder>/logs/backup-YYYY-MM-DD.log` for 30 days. A second backup cannot start while one runs. A local repository on Docker Desktop for macOS cannot be written (restic cannot sync a bind mount there): use a Linux host, a remote repository or `volume:`.

The same repository is reachable through `scripts/backup.sh restic <args>`, with the current folder mounted as `/restore`:

```sh
scripts/backup.sh restic snapshots
scripts/backup.sh restic stats latest
```

### Restore

Check regularly that a backup can be read, without touching the live server:

```sh
scripts/restore-test.sh        # restores the latest snapshot into a throwaway folder, opens the database, counts the projects
scripts/restore-test.sh 12     # same, and fails unless the database holds 12 projects
```

To restore into the live stack (it replaces the current data):

```sh
mkdir restore && cd restore
../scripts/backup.sh restic restore latest --tag redline --target .      # or a snapshot id instead of `latest`
cd ..
docker compose stop redline
docker compose run --rm --no-deps -v "$PWD/restore/data:/restore:ro" --entrypoint sh redline -c \
  'rm -rf /data/blobs /data/redline.db /data/redline.db-wal /data/redline.db-shm \
   && cp -a /restore/blobs /data/blobs && cp /restore/backup/redline.db /data/redline.db'
docker compose up -d
sudo rm -rf restore            # restored files keep the owner of the volume (uid 1000)
```

To restore on a new server: do "First install" (it creates the data volume), copy your backup settings folder to the new host, then run the commands above.

## Development

```sh
npm install
npm test                # fast suite
npm run build
npm run test:docker     # opt-in: builds the image: data survives container recreation, production compose, backup and restore
npm run eval:agent      # opt-in, costs real Claude sessions: see below
```

### Agent eval

`npm run eval:agent` checks how a real Claude uses Redline. For each scenario of `scripts/eval-scenarios/*.md` (a request written like a user's), it runs a headless `claude -p` with only the Redline MCP (`redline mcp`, from `packages/agent/dist`: run `npm run build` first) in a folder linked to a fresh project of a throwaway server. Then it opens every page the session made and checks, on the real canvas: refused Redline calls, design system gaps, overlapping boxes, elements over artboards, arrows crossing a box, cut titles and empty artboards. The report (`report.html`, screenshots and transcripts) lands in `.scratch/eval-runs/<date>/`. Each scenario costs one real session (about $0.60 with the default model). Flags: `--scenario <name>` (repeatable), `--model <model>`, `--budget <usd>` (per scenario, default 3), `--keep` (leave the server running to look at the pages).
