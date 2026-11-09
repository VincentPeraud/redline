import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialsOf, type MeResponse } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
const LOGOUT = "https://auth.example.com/logout";

describe("signed-in person", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-identity-"));
  });
  afterEach(async () => {
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = async (options: { sso: boolean; logoutUrl?: string; headers?: { userHeader: string; nameHeader: string; emailHeader: string } }) => {
    server = await startServer({
      dataDir,
      port: 0,
      artboardPort: 0,
      host: "127.0.0.1",
      proxySecrets: options.sso ? { human: HUMAN, machine: MACHINE } : undefined,
      identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email", ...options.headers, logoutUrl: options.logoutUrl },
    });
  };
  const me = async (headers: Record<string, string>): Promise<MeResponse> => {
    const response = await fetch(`${server!.url}/api/me`, { headers });
    expect(response.status).toBe(200);
    return (await response.json()) as MeResponse;
  };
  const signedIn = (name: string, email: string, user = "amartin") => ({
    [PROXY_SECRET_HEADER]: HUMAN,
    "remote-user": user,
    "remote-name": Buffer.from(name, "utf8").toString("latin1"),
    "remote-email": email,
  });

  it("returns the person with the logout URL, and makes the first one admin", async () => {
    await start({ sso: true, logoutUrl: LOGOUT });
    expect(await me(signedIn("Ariane Martin", "ariane@example.com"))).toEqual({
      id: "amartin",
      name: "Ariane Martin",
      email: "ariane@example.com",
      initials: "AM",
      logoutUrl: LOGOUT,
      account: { role: "admin", sso: true },
    });
  });

  it("refreshes the name and e-mail when the SSO changes them", async () => {
    await start({ sso: true });
    await me(signedIn("Ariane Martin", "ariane@example.com"));
    const renamed = await me(signedIn("Ariane Durand", "ariane@new.example.com"));
    expect(renamed).toMatchObject({ id: "amartin", name: "Ariane Durand", email: "ariane@new.example.com", initials: "AD", logoutUrl: null });
  });

  it("reads UTF-8 names", async () => {
    await start({ sso: true });
    expect(await me(signedIn("Éloïse Brûlé", "e@example.com"))).toMatchObject({ name: "Éloïse Brûlé", initials: "ÉB" });
  });

  it("answers null when the SSO sent no user id", async () => {
    await start({ sso: true, logoutUrl: LOGOUT });
    expect(await me({ [PROXY_SECRET_HEADER]: HUMAN })).toBeNull();
  });

  it("ignores the identity headers on requests without the human secret", async () => {
    await start({ sso: true });
    const { [PROXY_SECRET_HEADER]: _secret, ...forged } = signedIn("Ariane Martin", "ariane@example.com");
    expect((await fetch(`${server!.url}/api/me`, { headers: forged })).status).toBe(403);
    expect((await fetch(`${server!.url}/api/me`, { headers: { ...forged, [PROXY_SECRET_HEADER]: MACHINE } })).status).toBe(403);
  });

  it("ignores the identity headers when no SSO is configured", async () => {
    await start({ sso: false, logoutUrl: LOGOUT });
    expect(await me(signedIn("Ariane Martin", "ariane@example.com"))).toBeNull();
    expect(await me({})).toBeNull();
  });

  it("reads the headers named by the configuration", async () => {
    await start({ sso: true, headers: { userHeader: "x-auth-request-user", nameHeader: "x-auth-request-preferred-username", emailHeader: "x-auth-request-email" } });
    const person = await me({ [PROXY_SECRET_HEADER]: HUMAN, "x-auth-request-user": "bob", "x-auth-request-preferred-username": "Bob Stone", "x-auth-request-email": "bob@example.com" });
    expect(person).toMatchObject({ id: "bob", name: "Bob Stone", email: "bob@example.com" });
    expect(await me(signedIn("Ariane Martin", "ariane@example.com"))).toBeNull();
  });
});

describe("initials", () => {
  it("takes the first letters of the first and last words, or the user id without a name", () => {
    expect(initialsOf("Ariane Martin", "amartin")).toBe("AM");
    expect(initialsOf("Jean-Pierre de la Tour", "jp")).toBe("JT");
    expect(initialsOf("Madonna", "m")).toBe("MA");
    expect(initialsOf("", "amartin")).toBe("AM");
  });
});
