# No login in Redline: forwardAuth of an existing SSO plus two proxy secrets

Redline has no accounts, sessions or passwords. A deployment sits behind Traefik, which asks the installer's existing SSO (Authelia, Authentik, Keycloak through oauth2-proxy...) through a `forwardAuth` middleware, then forwards the signed-in person in identity headers whose names are configured in `.env`. Redline trusts those headers only on requests carrying a **proxy secret**, a random value Traefik adds and Redline checks, so another container on the shared Traefik network cannot reach Redline or forge a person.

There are two secrets: the human one (UI, API, artboards, behind the SSO) and the machine one (`/agent`, `/agent-api/*`, `/cli/*`, without SSO, guarded by the agents' token and rate limited). A request through the machine router can therefore never be taken for a person: the machine secret is accepted on the machine paths only and never makes identity headers readable. Each secret exists twice (a file read by Redline and a `.env` line read by the Traefik labels), written together by a generator that never overwrites.

## Considered Options

- **Native OIDC in Redline**: rejected. It needs sessions and cookies on two origins (UI and artboards), a user store and a logout flow: much more code, for something every target host already runs in front of its tools.
- **One shared secret**: rejected, because the machine route skips the SSO and must not be able to impersonate a person.
- **Trust the Docker network only**: rejected, because any container on the shared Traefik network can reach Redline's ports directly.
