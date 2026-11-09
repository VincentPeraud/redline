import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse } from "@redline/shared";
import { resolveAuthMode } from "../src/access.js";
import { startServer, type RunningServer } from "../src/start.js";

const JSON_HEADERS = { "content-type": "application/json" };
const PASSWORD = "correct horse";

describe("built-in accounts", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  let logs: string[];
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-accounts-"));
    logs = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => logs.push(line) });
    return server.url;
  };
  const setupToken = () => {
    const line = logs.find((l) => l.includes("/#/setup/"));
    return line?.split("/#/setup/")[1].trim();
  };
  const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
  const createAdmin = (url: string, token: string, email = "Vincent@Example.com") =>
    post(url, "/api/setup", { token, name: "Vincent Peraud", email, password: PASSWORD });
  const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0];
  const signIn = (url: string, email: string, password: string, ip?: string) =>
    post(url, "/api/session", { email, password }, ip ? { "x-forwarded-for": ip } : {});

  it("is the default mode when the variable is unset, and keeps proxy when secrets are given", () => {
    expect(resolveAuthMode({}, undefined)).toBe("local");
    expect(resolveAuthMode({ REDLINE_AUTH_MODE: "none" }, undefined)).toBe("none");
    expect(resolveAuthMode({}, { human: "h".repeat(32), machine: "m".repeat(32) })).toBe("proxy");
  });

  it("writes a setup link in the logs while no account exists, and gives nobody API access", async () => {
    const url = await start();
    expect(setupToken()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect((await fetch(`${url}/api/projects`)).status).toBe(401);
    expect((await fetch(`${url}/api/me`)).status).toBe(401);
    expect((await fetch(`${url}/api/setup?token=${setupToken()}`)).status).toBe(200);
    expect((await fetch(`${url}/api/setup?token=wrong`)).status).toBe(404);
  });

  it("creates the first admin once, gives them every existing project as Équipe, and signs them in", async () => {
    // Projects of an instance that predates accounts.
    const before = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "none" });
    await post(before.url, "/api/projects", { title: "Old" });
    await before.close();

    const url = await start();
    const token = setupToken()!;
    const tooShort = await post(url, "/api/setup", { token, name: "V", email: "v@example.com", password: "short" });
    expect(tooShort.status).toBe(400);
    expect((await post(url, "/api/setup", { token: "nope", name: "V", email: "v@example.com", password: PASSWORD })).status).toBe(404);

    const created = await createAdmin(url, token);
    expect(created.status).toBe(201);
    const cookie = cookieOf(created);
    expect(cookie).toMatch(/^redline_session=/);
    const setCookie = created.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=2592000/i);

    const me = (await (await fetch(`${url}/api/me`, { headers: { cookie } })).json()) as NonNullable<MeResponse>;
    expect(me).toMatchObject({ name: "Vincent Peraud", email: "Vincent@Example.com", account: { role: "admin" } });
    expect((await fetch(`${url}/api/projects`, { headers: { cookie } })).status).toBe(200);

    // The link is single use, and gone for good.
    expect((await createAdmin(url, token, "other@example.com")).status).toBe(404);
    await server!.close();
    logs = [];
    await start();
    expect(setupToken()).toBeUndefined();

    const owners = readOwnership(dataDir);
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) expect(owner).toMatchObject({ created_by: me.id, visibility: "team" });
    expect(owners.map((o) => o.title)).toContain("Old");
  });

  it("signs in by e-mail (any case) and password, and refuses a wrong password", async () => {
    const url = await start();
    await createAdmin(url, setupToken()!);
    const wrong = await signIn(url, "vincent@example.com", "not the password");
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("Email ou mot de passe incorrect.");
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const ok = await signIn(url, "VINCENT@example.COM", PASSWORD);
    expect(ok.status).toBe(200);
    expect((await fetch(`${url}/api/projects`, { headers: { cookie: cookieOf(ok) } })).status).toBe(200);
  });

  it("keeps a session for 30 days and signing out deletes only the current one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const url = await start();
    await createAdmin(url, setupToken()!);
    const first = cookieOf(await signIn(url, "vincent@example.com", PASSWORD));
    const second = cookieOf(await signIn(url, "vincent@example.com", PASSWORD));

    vi.setSystemTime(Date.now() + 29 * 86_400_000);
    expect((await fetch(`${url}/api/me`, { headers: { cookie: first } })).status).toBe(200);
    const out = await fetch(`${url}/api/session`, { method: "DELETE", headers: { cookie: first, "x-redline": "1" } });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect((await fetch(`${url}/api/me`, { headers: { cookie: first } })).status).toBe(401);
    expect((await fetch(`${url}/api/me`, { headers: { cookie: second } })).status).toBe(200);

    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    expect((await fetch(`${url}/api/me`, { headers: { cookie: second } })).status).toBe(401);
  });

  it("locks an e-mail for an IP after 5 failures for 15 minutes, with the same message whether it exists or not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const url = await start();
    await createAdmin(url, setupToken()!);
    const attempt = async (email: string, password: string, ip: string) => {
      const response = await signIn(url, email, password, ip);
      return { status: response.status, error: ((await response.json()) as { error?: string }).error };
    };
    for (let i = 0; i < 4; i++) expect((await attempt("vincent@example.com", "bad", "9.9.9.9")).status).toBe(401);
    expect((await attempt("vincent@example.com", "bad", "9.9.9.9")).status).toBe(429);
    const locked = await attempt("vincent@example.com", PASSWORD, "9.9.9.9");
    expect(locked.status).toBe(429);
    expect(locked.error).toMatch(/Trop d'essais/);

    for (let i = 0; i < 4; i++) await attempt("ghost@example.com", "bad", "9.9.9.9");
    expect(await attempt("ghost@example.com", "bad", "9.9.9.9")).toEqual(locked);
    expect(await attempt("ghost@example.com", "bad", "9.9.9.9")).toEqual(locked);

    expect((await attempt("vincent@example.com", PASSWORD, "8.8.8.8")).status).toBe(200);
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    expect((await attempt("vincent@example.com", PASSWORD, "9.9.9.9")).status).toBe(200);
  });

  it("asks mutating calls to carry JSON or a Redline header", async () => {
    const url = await start();
    const cookie = cookieOf(await createAdmin(url, setupToken()!));
    const bare = await fetch(`${url}/api/projects`, { method: "POST", headers: { cookie, "content-type": "text/plain" } });
    expect(bare.status).toBe(415);
    const bodyless = await fetch(`${url}/api/pages/p1/queue`, { method: "DELETE", headers: { cookie } });
    expect(bodyless.status).toBe(415);
    const withHeader = await fetch(`${url}/api/pages/p1/queue`, { method: "DELETE", headers: { cookie, "x-redline": "1" } });
    expect(withHeader.status).not.toBe(415);
    expect((await fetch(`${url}/api/projects`, { method: "POST", headers: { cookie, ...JSON_HEADERS }, body: JSON.stringify({ title: "P" }) })).status).toBe(201);
  });
});

function readOwnership(dir: string): { title: string; created_by: string; visibility: string }[] {
  // Read through a second connection: the server holds the file in WAL mode, which allows readers.
  const db = new Database(join(dir, "redline.db"), { readonly: true });
  const rows = db.prepare("SELECT title, created_by, visibility FROM projects").all() as { title: string; created_by: string; visibility: string }[];
  db.close();
  return rows;
}
