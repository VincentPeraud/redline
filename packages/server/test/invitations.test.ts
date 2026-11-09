import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsResponse, InvitationEntry, InvitationPreview } from "@redline/shared";
import { startServer, type RunningServer } from "../src/start.js";

const JSON_HEADERS = { "content-type": "application/json" };
const PASSWORD = "correct horse";
const DAY = 86_400_000;

describe("accounts screen and invitations", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  let logs: string[];
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-invitations-"));
    logs = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const send = (method: string, path: string, body?: unknown, cookie?: string) =>
    fetch(server!.url + path, { method, headers: { ...(body === undefined ? { "x-redline": "1" } : JSON_HEADERS), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0];

  /** Starts the server and signs the first admin in. */
  const startWithAdmin = async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => logs.push(line) });
    const token = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
    const created = await send("POST", "/api/setup", { token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD });
    return cookieOf(created);
  };
  const invite = async (admin: string, email = "marc@example.com", role = "member") => {
    const response = await send("POST", "/api/accounts/invitations", { email, role }, admin);
    return { response, invitation: (await response.json()) as InvitationEntry };
  };
  const accept = (token: string, name = "Marc Durand", password = PASSWORD) => send("POST", "/api/invitation", { token, name, password });
  const list = async (cookie: string) => (await (await send("GET", "/api/accounts", undefined, cookie)).json()) as AccountsResponse;

  it("lists the accounts and the pending invitations for an admin", async () => {
    const admin = await startWithAdmin();
    const { response, invitation } = await invite(admin, "Marc@Example.com", "admin");
    expect(response.status).toBe(201);
    expect(invitation).toMatchObject({ email: "Marc@Example.com", role: "admin", invitedBy: "Vincent Peraud" });
    expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(7 * DAY);

    const { accounts, invitations } = await list(admin);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: "Vincent Peraud", email: "vincent@example.com", role: "admin", status: "active" });
    expect(invitations).toEqual([invitation]);
  });

  it("refuses accounts and invitations to members and to nobody", async () => {
    const admin = await startWithAdmin();
    const { invitation } = await invite(admin);
    const member = cookieOf(await accept(invitation.token));
    expect(member).toMatch(/^redline_session=/);

    expect((await send("GET", "/api/accounts", undefined, member)).status).toBe(403);
    expect((await send("POST", "/api/accounts/invitations", { email: "x@example.com", role: "member" }, member)).status).toBe(403);
    expect((await send("DELETE", `/api/accounts/invitations/${invitation.id}`, undefined, member)).status).toBe(403);
    expect((await send("GET", "/api/accounts")).status).toBe(401);
  });

  it("previews an invitation to anyone, then creates the account once, signs them in and shows them in the list", async () => {
    const admin = await startWithAdmin();
    const { invitation } = await invite(admin, "marc@example.com", "member");

    const preview = await fetch(`${server!.url}/api/invitation?token=${invitation.token}`);
    expect(preview.status).toBe(200);
    expect((await preview.json()) as InvitationPreview).toEqual({ email: "marc@example.com", role: "member", invitedBy: "Vincent Peraud", expiresAt: invitation.expiresAt });

    expect((await accept(invitation.token, "Marc", "short")).status).toBe(400);
    const accepted = await accept(invitation.token);
    expect(accepted.status).toBe(201);
    const me = (await (await send("GET", "/api/me", undefined, cookieOf(accepted))).json()) as { name: string; email: string; account: { role: string } };
    expect(me).toMatchObject({ name: "Marc Durand", email: "marc@example.com", account: { role: "member" } });

    // Single use.
    expect((await accept(invitation.token, "Someone else")).status).toBe(404);
    expect((await fetch(`${server!.url}/api/invitation?token=${invitation.token}`)).status).toBe(404);

    const { accounts, invitations } = await list(admin);
    expect(invitations).toEqual([]);
    expect(accounts.map((a) => [a.name, a.role])).toEqual([["Vincent Peraud", "admin"], ["Marc Durand", "member"]]);
    // They can sign in with their password.
    expect((await send("POST", "/api/session", { email: "MARC@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("keeps an invitation for 7 days, then it is neither listed nor usable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const admin = await startWithAdmin();
    const { invitation } = await invite(admin);
    vi.setSystemTime(Date.now() + 7 * DAY - 1000);
    expect((await fetch(`${server!.url}/api/invitation?token=${invitation.token}`)).status).toBe(200);
    vi.setSystemTime(Date.now() + 2000);
    expect((await fetch(`${server!.url}/api/invitation?token=${invitation.token}`)).status).toBe(404);
    expect((await accept(invitation.token)).status).toBe(404);
  });

  it("copies a pending invitation again, and cancelling it kills the link", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const admin = await startWithAdmin();
    const { invitation } = await invite(admin);
    expect((await list(admin)).invitations[0].token).toBe(invitation.token);
    vi.setSystemTime(Date.now() + 8 * DAY);
    // The session of the admin lasts 30 days; the expired invitation is no longer pending.
    expect((await list(admin)).invitations).toEqual([]);
    vi.setSystemTime(Date.now() - 8 * DAY);

    expect((await send("DELETE", `/api/accounts/invitations/${invitation.id}`, undefined, admin)).status).toBe(204);
    expect((await send("DELETE", `/api/accounts/invitations/${invitation.id}`, undefined, admin)).status).toBe(404);
    expect((await accept(invitation.token)).status).toBe(404);
    expect((await list(admin)).invitations).toEqual([]);
  });

  it("refuses an invalid e-mail, an unknown role, an e-mail that has an account or a pending invitation", async () => {
    const admin = await startWithAdmin();
    expect((await invite(admin, "not an email")).response.status).toBe(400);
    expect((await invite(admin, "x@example.com", "owner")).response.status).toBe(400);
    expect((await invite(admin, "VINCENT@example.com")).response.status).toBe(409);
    expect((await invite(admin, "marc@example.com")).response.status).toBe(201);
    expect((await invite(admin, "Marc@Example.com")).response.status).toBe(409);
  });
});
