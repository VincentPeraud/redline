import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountEntry, AccountsResponse, InvitationEntry, PasswordLinkEntry, PasswordLinkPreview } from "@redline/shared";
import { startServer, type RunningServer } from "../src/start.js";

const JSON_HEADERS = { "content-type": "application/json" };
const PASSWORD = "correct horse";
const NEW_PASSWORD = "battery staple";
const HOUR = 3_600_000;

describe("account management and Mon compte", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  let logs: string[];
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-management-"));
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
  const list = async (cookie: string) => ((await (await send("GET", "/api/accounts", undefined, cookie)).json()) as AccountsResponse).accounts;
  const accountOf = async (cookie: string, email: string) => (await list(cookie)).find((a) => a.email === email)!;

  const startWithAdmin = async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => logs.push(line) });
    const token = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
    return cookieOf(await send("POST", "/api/setup", { token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }));
  };
  /** Invites and signs in a person; returns their session cookie. */
  const join_ = async (admin: string, email: string, name: string, role = "member") => {
    const invitation = (await (await send("POST", "/api/accounts/invitations", { email, role }, admin)).json()) as InvitationEntry;
    return cookieOf(await send("POST", "/api/invitation", { token: invitation.token, name, password: PASSWORD }));
  };
  const signIn = (email: string, password: string) => send("POST", "/api/session", { email, password });
  const passwordLink = async (admin: string, id: string) => {
    const response = await send("POST", `/api/accounts/${id}/password-link`, undefined, admin);
    return { response, link: (await response.json()) as PasswordLinkEntry };
  };

  describe("password link", () => {
    it("lets a member choose a new password once, signs them in and signs their other devices out", async () => {
      const admin = await startWithAdmin();
      const oldDevice = await join_(admin, "ariane@example.com", "Ariane Martin");
      const ariane = await accountOf(admin, "ariane@example.com");

      const { response, link } = await passwordLink(admin, ariane.id);
      expect(response.status).toBe(201);
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(23 * HOUR);

      const preview = await fetch(`${server!.url}/api/password-link?token=${link.token}`);
      expect((await preview.json()) as PasswordLinkPreview).toEqual({ email: "ariane@example.com", expiresAt: link.expiresAt });

      expect((await send("POST", "/api/password-link", { token: link.token, password: "short" })).status).toBe(400);
      const used = await send("POST", "/api/password-link", { token: link.token, password: NEW_PASSWORD });
      expect(used.status).toBe(200);
      const newDevice = cookieOf(used);
      expect((await send("GET", "/api/me", undefined, newDevice)).status).toBe(200);
      expect((await send("GET", "/api/me", undefined, oldDevice)).status).toBe(401);
      expect((await signIn("ariane@example.com", PASSWORD)).status).toBe(401);
      expect((await signIn("ariane@example.com", NEW_PASSWORD)).status).toBe(200);

      expect((await send("POST", "/api/password-link", { token: link.token, password: NEW_PASSWORD })).status).toBe(404);
      expect((await fetch(`${server!.url}/api/password-link?token=${link.token}`)).status).toBe(404);
    });

    it("expires after 24 hours and a newer link replaces the older one", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const admin = await startWithAdmin();
      await join_(admin, "ariane@example.com", "Ariane Martin");
      const ariane = await accountOf(admin, "ariane@example.com");

      const first = (await passwordLink(admin, ariane.id)).link;
      const second = (await passwordLink(admin, ariane.id)).link;
      expect((await fetch(`${server!.url}/api/password-link?token=${first.token}`)).status).toBe(404);
      vi.setSystemTime(Date.now() + 24 * HOUR - 1000);
      expect((await fetch(`${server!.url}/api/password-link?token=${second.token}`)).status).toBe(200);
      vi.setSystemTime(Date.now() + 2000);
      expect((await fetch(`${server!.url}/api/password-link?token=${second.token}`)).status).toBe(404);
      expect((await send("POST", "/api/password-link", { token: second.token, password: NEW_PASSWORD })).status).toBe(404);
    });

    it("is for admins only and for accounts that exist and are active", async () => {
      const admin = await startWithAdmin();
      const member = await join_(admin, "ariane@example.com", "Ariane Martin");
      await join_(admin, "thomas@example.com", "Thomas Lefèvre");
      const ariane = await accountOf(admin, "ariane@example.com");
      const thomas = await accountOf(admin, "thomas@example.com");

      expect((await send("POST", `/api/accounts/${thomas.id}/password-link`, undefined, member)).status).toBe(403);
      expect((await passwordLink(admin, "nobody")).response.status).toBe(404);
      await send("POST", `/api/accounts/${ariane.id}/deactivate`, undefined, admin);
      expect((await passwordLink(admin, ariane.id)).response.status).toBe(404);
    });
  });

  describe("roles", () => {
    it("promotes a member to admin, who can then manage accounts, and brings an admin back to member", async () => {
      const admin = await startWithAdmin();
      const ariane = await join_(admin, "ariane@example.com", "Ariane Martin");
      const arianeId = (await accountOf(admin, "ariane@example.com")).id;
      expect((await send("GET", "/api/accounts", undefined, ariane)).status).toBe(403);

      const promoted = await send("PATCH", `/api/accounts/${arianeId}`, { role: "admin" }, admin);
      expect(promoted.status).toBe(200);
      expect(((await promoted.json()) as AccountEntry).role).toBe("admin");
      expect((await send("GET", "/api/accounts", undefined, ariane)).status).toBe(200);

      expect((await send("PATCH", `/api/accounts/${arianeId}`, { role: "member" }, admin)).status).toBe(200);
      expect((await send("GET", "/api/accounts", undefined, ariane)).status).toBe(403);
      expect((await send("PATCH", `/api/accounts/${arianeId}`, { role: "owner" }, admin)).status).toBe(400);
      expect((await send("PATCH", "/api/accounts/nobody", { role: "admin" }, admin)).status).toBe(404);
      expect((await send("PATCH", `/api/accounts/${arianeId}`, { role: "admin" }, ariane)).status).toBe(403);
    });

    it("refuses to lower the last active admin, but lowers one of two", async () => {
      const admin = await startWithAdmin();
      const me = await accountOf(admin, "vincent@example.com");
      const refused = await send("PATCH", `/api/accounts/${me.id}`, { role: "member" }, admin);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "last-admin", error: "Il faut au moins un admin." });

      const second = await join_(admin, "ariane@example.com", "Ariane Martin", "admin");
      expect((await send("PATCH", `/api/accounts/${me.id}`, { role: "member" }, admin)).status).toBe(200);
      // Ariane is now the last one.
      const arianeId = (await accountOf(second, "ariane@example.com")).id;
      expect((await send("PATCH", `/api/accounts/${arianeId}`, { role: "member" }, second)).status).toBe(409);
    });

    it("does not count a deactivated admin as one", async () => {
      const admin = await startWithAdmin();
      const second = await join_(admin, "ariane@example.com", "Ariane Martin", "admin");
      const arianeId = (await accountOf(admin, "ariane@example.com")).id;
      const me = await accountOf(admin, "vincent@example.com");
      expect((await send("POST", `/api/accounts/${arianeId}/deactivate`, undefined, admin)).status).toBe(200);
      expect((await send("PATCH", `/api/accounts/${me.id}`, { role: "member" }, admin)).status).toBe(409);
      expect((await send("GET", "/api/me", undefined, second)).status).toBe(401);
    });
  });

  describe("deactivation", () => {
    it("deletes the sessions at once, refuses sign-in, hands the projects to the admin and keeps the name in the list", async () => {
      const admin = await startWithAdmin();
      const thomasCookie = await join_(admin, "thomas@example.com", "Thomas Lefèvre");
      const thomas = await accountOf(admin, "thomas@example.com");
      const project = (await (await send("POST", "/api/projects", { title: "Essais Thomas" }, thomasCookie)).json()) as { id: string };
      const db = new Database(join(dataDir, "redline.db"));
      db.prepare("UPDATE projects SET created_by = ? WHERE id = ?").run(thomas.id, project.id);
      db.close();
      expect((await accountOf(admin, "thomas@example.com")).ownedProjects).toEqual(["Essais Thomas"]);

      const response = await send("POST", `/api/accounts/${thomas.id}/deactivate`, undefined, admin);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: thomas.id, name: "Thomas Lefèvre", status: "deactivated", ownedProjects: [] });
      expect((await send("GET", "/api/me", undefined, thomasCookie)).status).toBe(401);
      expect((await signIn("thomas@example.com", PASSWORD)).status).toBe(401);
      expect((await accountOf(admin, "vincent@example.com")).ownedProjects).toContain("Essais Thomas");
    });

    it("refuses to deactivate the last active admin, and oneself", async () => {
      const admin = await startWithAdmin();
      const me = await accountOf(admin, "vincent@example.com");
      const refused = await send("POST", `/api/accounts/${me.id}/deactivate`, undefined, admin);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "last-admin" });

      const second = await join_(admin, "ariane@example.com", "Ariane Martin", "admin");
      const own = await send("POST", `/api/accounts/${me.id}/deactivate`, undefined, admin);
      expect(own.status).toBe(409);
      expect(await own.json()).toMatchObject({ code: "self-deactivation" });
      expect((await send("GET", "/api/me", undefined, second)).status).toBe(200);
    });

    it("reactivates an account, which signs in again with the same password", async () => {
      const admin = await startWithAdmin();
      await join_(admin, "thomas@example.com", "Thomas Lefèvre");
      const thomas = await accountOf(admin, "thomas@example.com");
      await send("POST", `/api/accounts/${thomas.id}/deactivate`, undefined, admin);
      expect((await send("POST", `/api/accounts/${thomas.id}/reactivate`, undefined, admin)).status).toBe(200);
      expect((await accountOf(admin, "thomas@example.com")).status).toBe("active");
      expect((await signIn("thomas@example.com", PASSWORD)).status).toBe(200);
      expect((await send("POST", `/api/accounts/${thomas.id}/reactivate`, undefined, admin)).status).toBe(200);
    });

    it("is for admins only", async () => {
      const admin = await startWithAdmin();
      const member = await join_(admin, "thomas@example.com", "Thomas Lefèvre");
      const me = await accountOf(admin, "vincent@example.com");
      expect((await send("POST", `/api/accounts/${me.id}/deactivate`, undefined, member)).status).toBe(403);
      expect((await send("POST", `/api/accounts/${me.id}/reactivate`, undefined, member)).status).toBe(403);
    });
  });

  describe("Mon compte", () => {
    it("changes the name, shown everywhere the person is", async () => {
      const admin = await startWithAdmin();
      const response = await send("PATCH", "/api/account", { name: "  Vincent P.  " }, admin);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: "Vincent P.", initials: "VP" });
      expect(((await (await send("GET", "/api/me", undefined, admin)).json()) as { name: string }).name).toBe("Vincent P.");
      expect((await accountOf(admin, "vincent@example.com")).name).toBe("Vincent P.");
      expect((await send("PATCH", "/api/account", { name: "   " }, admin)).status).toBe(400);
      expect((await send("PATCH", "/api/account", { name: "x" })).status).toBe(401);
    });

    it("changes the password when the old one is right, keeps this device and signs the others out", async () => {
      const admin = await startWithAdmin();
      const otherDevice = cookieOf(await signIn("vincent@example.com", PASSWORD));
      expect((await send("POST", "/api/account/password", { currentPassword: "wrong one", newPassword: NEW_PASSWORD }, admin)).status).toBe(400);
      expect((await send("POST", "/api/account/password", { currentPassword: PASSWORD, newPassword: "short" }, admin)).status).toBe(400);
      expect((await send("GET", "/api/me", undefined, otherDevice)).status).toBe(200);

      const changed = await send("POST", "/api/account/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, admin);
      expect(changed.status).toBe(204);
      expect((await send("GET", "/api/me", undefined, admin)).status).toBe(200);
      expect((await send("GET", "/api/me", undefined, otherDevice)).status).toBe(401);
      expect((await signIn("vincent@example.com", PASSWORD)).status).toBe(401);
      expect((await signIn("vincent@example.com", NEW_PASSWORD)).status).toBe(200);
    });
  });
});
