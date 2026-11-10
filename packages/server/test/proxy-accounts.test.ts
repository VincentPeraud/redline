import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountsResponse, InvitationEntry, MeResponse } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
const JSON_HEADERS = { "content-type": "application/json" };

const sso = (user: string, email: string, name = user) => ({ [PROXY_SECRET_HEADER]: HUMAN, "remote-user": user, "remote-name": name, "remote-email": email });
const VINCENT = sso("vincent", "vincent@example.com", "Vincent Peraud");
const ARIANE = sso("amartin", "ariane@example.com", "Ariane Martin");
const MARC = sso("mdurand", "marc@example.com", "Marc Durand");

describe("accounts behind an SSO (proxy mode)", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-proxy-accounts-"));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const startProxy = async () => {
    server = await startServer({
      dataDir,
      port: 0,
      artboardPort: 0,
      host: "127.0.0.1",
      authMode: "proxy",
      firstAdminEmail: "vincent@example.com",
      proxySecrets: { human: HUMAN, machine: MACHINE },
      identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" },
    });
  };
  const stop = async () => {
    await server?.close();
    server = undefined;
  };
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(server!.url + path, { method, headers: { ...headers, "x-redline": "1", ...(body === undefined ? {} : JSON_HEADERS) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const me = async (headers: Record<string, string>) => (await (await call("GET", "/api/me", headers)).json()) as NonNullable<MeResponse>;
  const accounts = async (headers: Record<string, string>) => (await (await call("GET", "/api/accounts", headers)).json()) as AccountsResponse;
  const add = (admin: Record<string, string>, email: string, role = "member") => call("POST", "/api/accounts/invitations", admin, { email, role });

  it("makes the first SSO person admin, and keeps everyone else out until an admin adds them", async () => {
    await startProxy();
    expect(await me(VINCENT)).toMatchObject({ id: "vincent", account: { role: "admin" } });
    expect((await call("GET", "/api/projects", VINCENT)).status).toBe(200);

    const outsider = await me(ARIANE);
    expect(outsider).toMatchObject({ id: "amartin", email: "ariane@example.com", noAccess: { admins: [{ name: "Vincent Peraud", email: "vincent@example.com" }] } });
    expect(outsider.account).toBeUndefined();
    expect((await call("GET", "/api/projects", ARIANE)).status).toBe(403);
    expect((await call("GET", "/api/accounts", ARIANE)).status).toBe(403);
  });

  it("makes only the person with the first admin e-mail admin, even when others sign in at the same moment", async () => {
    await startProxy();
    const [first, second] = await Promise.all([me(ARIANE), me(VINCENT)]);
    expect(first.account).toBeUndefined();
    expect(second.account?.role).toBe("admin");
    expect((await accounts(VINCENT)).accounts).toHaveLength(1);
  });

  it("adds a person by e-mail, pending without expiry or link until their first SSO sign-in, and cancellable", async () => {
    await startProxy();
    await me(VINCENT);
    const added = await add(VINCENT, "Marc@Example.com", "member");
    expect(added.status).toBe(201);
    const pending = (await added.json()) as InvitationEntry;
    expect(pending).toMatchObject({ email: "Marc@Example.com", role: "member", invitedBy: "Vincent Peraud", expiresAt: null, token: "" });

    const listed = await accounts(VINCENT);
    expect(listed.sso).toBe(true);
    expect(listed.invitations).toEqual([pending]);

    expect((await call("DELETE", `/api/accounts/invitations/${pending.id}`, VINCENT)).status).toBe(204);
    expect((await accounts(VINCENT)).invitations).toEqual([]);
    expect((await me(MARC)).account).toBeUndefined();
  });

  it("binds a pending person to their SSO user id at first sign-in, then refreshes their e-mail", async () => {
    await startProxy();
    await me(VINCENT);
    await add(VINCENT, "marc@example.com", "admin");
    expect(await me(MARC)).toMatchObject({ id: "mdurand", account: { role: "admin" } });
    const listed = await accounts(VINCENT);
    expect(listed.invitations).toEqual([]);
    expect(listed.accounts.map((a) => [a.email, a.role, a.status])).toEqual([
      ["vincent@example.com", "admin", "active"],
      ["marc@example.com", "admin", "active"],
    ]);
    expect(listed.accounts[1].lastSignInAt).not.toBeNull();

    const renamed = sso("mdurand", "marc@new.example.com", "Marc D.");
    expect(await me(renamed)).toMatchObject({ id: "mdurand", email: "marc@new.example.com", account: { role: "admin" } });
    // The old e-mail no longer gives anyone else the account: only the user id does.
    const stranger = sso("someone-else", "marc@new.example.com");
    expect((await me(stranger)).account).toBeUndefined();
  });

  it("refuses to add an e-mail that already has an account or a pending entry", async () => {
    await startProxy();
    await me(VINCENT);
    expect((await add(VINCENT, "vincent@example.com")).status).toBe(409);
    expect((await add(VINCENT, "marc@example.com")).status).toBe(201);
    expect((await add(VINCENT, "MARC@example.com")).status).toBe(409);
  });

  it("lets members see no accounts and offers no password, setup or invitation-link routes", async () => {
    await startProxy();
    await me(VINCENT);
    await add(VINCENT, "ariane@example.com");
    expect((await me(ARIANE)).account).toMatchObject({ role: "member" });
    expect((await call("GET", "/api/accounts", ARIANE)).status).toBe(403);
    expect((await add(ARIANE, "x@example.com")).status).toBe(403);
    for (const path of ["/api/setup", "/api/session", "/api/invitation"]) {
      expect((await call("POST", path, VINCENT, { token: "x" })).status, path).toBeGreaterThanOrEqual(400);
    }
  });

  it("gives the history of a person seen before the accounts to them once an admin adds them", async () => {
    await startProxy();
    await stop();
    const db = new Database(join(dataDir, "redline.db"));
    db.prepare("INSERT INTO people (id, name, email, created_at) VALUES ('old', 'Olivia Old', 'olivia@example.com', '2026-01-01T00:00:00.000Z')").run();
    db.close();
    await startProxy();

    const olivia = sso("old", "olivia@example.com", "Olivia Old");
    // On an instance already behind the SSO, the first person in becomes admin; the people seen before get nothing.
    expect(await me(VINCENT)).toMatchObject({ account: { role: "admin" } });
    expect((await me(olivia)).account).toBeUndefined();
    await add(VINCENT, "olivia@example.com");
    expect(await me(olivia)).toMatchObject({ id: "old", account: { role: "member" } });
    expect((await accounts(VINCENT)).accounts.map((a) => a.id)).toContain("old");
  });

  it("matches an account of a former local mode by e-mail at its first SSO sign-in, keeping its id and role", async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => (setupLink = line) });
    const token = setupLink.split("/#/setup/")[1].trim();
    const created = await fetch(server.url + "/api/setup", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "Vincent@Example.com", password: "correct horse" }) });
    const localId = ((await created.json()) as { id: string }).id;
    await stop();

    await startProxy();
    expect(await me(VINCENT)).toMatchObject({ id: localId, name: "Vincent Peraud", account: { role: "admin" } });
    // The instance had an account, so nobody else became admin.
    expect((await me(ARIANE)).account).toBeUndefined();
    expect((await accounts(VINCENT)).accounts).toHaveLength(1);
  });
  let setupLink = "";
});
