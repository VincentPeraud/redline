import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_API_PREFIX, TOKEN_HEADER, type AgentTokenResponse } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";

const JSON_HEADERS = { "content-type": "application/json" };
const PUBLIC_URL = "https://redline.example";

describe("agent sign-in link", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-agent-sign-in-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A local-mode instance with an admin, and that admin's agent token. */
  async function localInstance() {
    const logs: string[] = [];
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", publicUrl: PUBLIC_URL, log: (line) => logs.push(line) });
    const setup = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
    const created = await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token: setup, name: "Vincent", email: "v@example.com", password: "correct horse" }) });
    const cookie = created.headers.get("set-cookie")!.split(";")[0];
    const { token } = (await (await fetch(`${server.url}/api/agent-token`, { headers: { cookie } })).json()) as AgentTokenResponse;
    return { token, cookie, logs };
  }

  const issue = (token: string | undefined, body: unknown = {}) =>
    fetch(`${server!.url}${AGENT_API_PREFIX}/sign-in-link`, { method: "POST", headers: { ...JSON_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const consume = (linkToken: string) => fetch(`${server!.url}/api/agent-sign-in`, { method: "POST", headers: { ...JSON_HEADERS, [TOKEN_HEADER]: linkToken }, body: "{}" });
  const tokenOf = (url: string) => new URL(url).hash.split("/")[2].split("?")[0];

  it("gives a link that signs the browser in as the token's account, once", async () => {
    const { token, logs } = await localInstance();
    const response = await issue(token, { path: "#/projects" });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(url.startsWith(`${PUBLIC_URL}/#/connexion-agent/`)).toBe(true);
    expect(decodeURIComponent(url)).toContain("to=#/projects");

    const signedIn = await consume(tokenOf(url));
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    const me = await (await fetch(`${server!.url}/api/me`, { headers: { cookie: cookie.split(";")[0] } })).json();
    expect(me).toMatchObject({ email: "v@example.com" });

    expect((await consume(tokenOf(url))).status).toBe(404);
    expect(logs.some((line) => line.includes("v@example.com") && line.includes(tokenOf(url)))).toBe(false);
    expect(logs.some((line) => line.includes("v@example.com") && line.includes("sign-in link"))).toBe(true);
  });

  const preview = (linkToken: string) => fetch(`${server!.url}/api/agent-sign-in/preview`, { method: "POST", headers: { ...JSON_HEADERS, [TOKEN_HEADER]: linkToken }, body: "{}" });

  it("previews who the link signs in without using it up", async () => {
    const { token } = await localInstance();
    const { url } = (await (await issue(token)).json()) as { url: string };
    const shown = await preview(tokenOf(url));
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ name: "Vincent", email: "v@example.com" });
    expect(shown.headers.get("set-cookie")).toBeNull();
    expect((await preview(tokenOf(url))).status).toBe(200);
    expect((await consume(tokenOf(url))).status).toBe(200);
    expect((await preview(tokenOf(url))).status).toBe(404);
    expect((await preview("unknown")).status).toBe(404);
  });

  it("opens a 12-hour session that keeps the account's rights", async () => {
    const { token } = await localInstance();
    const { url } = (await (await issue(token)).json()) as { url: string };
    const cookie = (await consume(tokenOf(url))).headers.get("set-cookie")!;
    expect(cookie).toContain("Max-Age=43200");
    expect((await fetch(`${server!.url}/api/accounts`, { headers: { cookie: cookie.split(";")[0] } })).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 13 * 3_600_000 });
    expect((await fetch(`${server!.url}/api/me`, { headers: { cookie: cookie.split(";")[0] } })).status).toBe(401);
  });

  it("ends its agent sessions and pending links when the agent token is regenerated, and leaves the other sessions", async () => {
    const { token, cookie } = await localInstance();
    const first = (await (await issue(token)).json()) as { url: string };
    const agentCookie = (await consume(tokenOf(first.url))).headers.get("set-cookie")!.split(";")[0];
    const pending = (await (await issue(token)).json()) as { url: string };
    expect((await fetch(`${server!.url}/api/me`, { headers: { cookie: agentCookie } })).status).toBe(200);

    expect((await fetch(`${server!.url}/api/agent-token/regenerate`, { method: "POST", headers: { ...JSON_HEADERS, cookie }, body: "{}" })).status).toBeLessThan(300);

    expect((await fetch(`${server!.url}/api/me`, { headers: { cookie: agentCookie } })).status).toBe(401);
    expect((await consume(tokenOf(pending.url))).status).toBe(404);
    expect((await fetch(`${server!.url}/api/me`, { headers: { cookie } })).status).toBe(200);
  });

  it("stops working after 60 seconds", async () => {
    const { token } = await localInstance();
    const { url } = (await (await issue(token)).json()) as { url: string };
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    expect((await consume(tokenOf(url))).status).toBe(404);
  });

  it("works just before 60 seconds", async () => {
    const { token } = await localInstance();
    const { url } = (await (await issue(token)).json()) as { url: string };
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 59_000 });
    expect((await consume(tokenOf(url))).status).toBe(200);
  });

  it("refuses an unknown agent token and an unknown link", async () => {
    const { token } = await localInstance();
    expect((await issue("nope")).status).toBe(401);
    expect((await issue(undefined)).status).toBe(401);
    expect((await consume("unknown")).status).toBe(404);
    expect(token).toBeTruthy();
  });

  it("refuses a deactivated account, at issue and at use", async () => {
    const { token, cookie } = await localInstance();
    const { url } = (await (await issue(token)).json()) as { url: string };
    const db = (await import("better-sqlite3")).default;
    const handle = new db(join(dataDir, "redline.db"));
    handle.prepare("UPDATE people SET status = 'deactivated'").run();
    handle.close();
    expect((await consume(tokenOf(url))).status).toBe(404);
    expect((await issue(token)).status).toBe(401);
    expect(cookie).toBeTruthy();
  });

  it("refuses to be asked for a path that is not inside the app", async () => {
    const { token } = await localInstance();
    expect((await issue(token, { path: "https://evil.example" })).status).toBe(400);
  });

  it("is 409 behind an SSO", async () => {
    const HUMAN = "h".repeat(32);
    const MACHINE = "m".repeat(32);
    const vincent = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "vincent", "remote-name": "Vincent", "remote-email": "v@example.com" };
    server = await startServer({
      dataDir,
      port: 0,
      artboardPort: 0,
      host: "127.0.0.1",
      authMode: "proxy",
      firstAdminEmail: "v@example.com",
      proxySecrets: { human: HUMAN, machine: MACHINE },
      identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" },
    });
    await fetch(`${server.url}/api/me`, { headers: vincent });
    const { token } = (await (await fetch(`${server.url}/api/agent-token`, { headers: vincent })).json()) as AgentTokenResponse;
    const response = await fetch(`${server.url}${AGENT_API_PREFIX}/sign-in-link`, { method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, [PROXY_SECRET_HEADER]: MACHINE }, body: "{}" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/SSO/);
  });

  it("gives the plain app url without accounts", async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "none", publicUrl: "http://localhost:3000" });
    const { token } = (await (await fetch(`${server.url}/api/agent-token`)).json()) as AgentTokenResponse;
    const response = await issue(token, { path: "#/projects" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "http://localhost:3000/#/projects" });
  });
});
