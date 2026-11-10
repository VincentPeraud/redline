# Redline has its own accounts, switchable to an SSO

Status: supersedes ADR 0003.

Redline used to have no accounts: everything behind the SSO was one trusted space. It now has **accounts** (admin or member), sessions and per-project permissions in every mode, chosen with `REDLINE_AUTH_MODE`:

- `local` (the default of the local compose file): Redline signs people in with e-mail and password. The first admin is created through a single-use setup link written to the container logs, and others come in by invitation link. `redline-server reset-admin` writes a new password link when nobody can sign in.
- `proxy`: an SSO (Authelia, Authentik, Keycloak through oauth2-proxy...) signs people in through Traefik `forwardAuth` and only tells Redline who they are, in identity headers. Redline keeps its own list of accounts, like Agora: `REDLINE_FIRST_ADMIN_EMAIL` is required and Redline refuses to start without it; on an instance with no account only the SSO person with that e-mail becomes the first admin, admins add members by e-mail, and a signed-in person who is not on the list has no access. The two proxy secrets of ADR 0003 stay, unchanged.
- `none`: no authentication, for development and tests.

Two things leave the SSO's reach in proxy mode:

- **Share links** (`/s/<token>`) are for people with no account, so Traefik sends `/s/*` (and the app bundle under `/assets/`) to Redline without the SSO middleware but with the human proxy secret. Redline serves a link only its own scope, and the visitor's API calls live under `/s/<token>/api/...` so that this one router is enough.
- **The artboard origin** is guarded by a short-lived signed viewing capability in each URL (`/c/<capability>/...`), issued by the main app to a viewer allowed to see the project. Its router no longer goes through the SSO and keeps the human proxy secret. This also closes the gap of an unauthenticated artboard origin.

**Prerequisite in proxy mode: the e-mails the SSO sends are set by the SSO's admin, never editable by the users themselves** (true for Authelia's file backend). Redline matches an SSO person to a pending entry, to an account of a former local mode and to the first admin by e-mail, so a user who could choose their own e-mail could take over someone else's account. The deploy documentation states it.

Link tokens and agent tokens are stored readable (so a link can be copied again): the database and its backups are the trust boundary.

## Considered Options

- **Keep ADR 0003 (no accounts)**: rejected. Without identity there is no private project, no per-person agent token and no way to share a page with a client.
- **Native OIDC in Redline**: still rejected, for the reasons of ADR 0003. Proxy mode covers every SSO through the reverse proxy.
- **SSO only, no built-in sign-in**: rejected. A local install or a small team without an SSO would have no protection at all, which is how a tunnel exposed everything.
- **Built-in accounts only**: rejected. Installers who already run an SSO keep using it, with two-factor authentication and passkeys handled there.
