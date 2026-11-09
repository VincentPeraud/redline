import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_PATH, type Person, type Project } from "@redline/shared";
import { hashPassword } from "../src/accounts.js";
import { startServer, type RunningServer } from "../src/start.js";

const JSON_HEADERS = { "content-type": "application/json" };
export const PASSWORD = "correct horse";
export const FILES = { "home.html": "<h1>Home</h1>", [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };

export interface SignedIn {
  get: (path: string) => Promise<Response>;
  send: (method: string, path: string, body?: unknown) => Promise<Response>;
  json: <T>(path: string) => Promise<T>;
  cookie: string;
}

/** A running instance in local mode with an admin (Vincent) and members (Ariane, Thomas, Marc), each signed in. */
export class AccountsInstance {
  server!: RunningServer;
  dataDir = mkdtempSync(join(tmpdir(), "redline-accounts-"));
  admin!: SignedIn;
  ariane!: SignedIn;
  thomas!: SignedIn;
  marc!: SignedIn;
  people: Record<"ariane" | "thomas" | "marc", Person> = {} as never;

  async start(): Promise<this> {
    const logs: string[] = [];
    this.server = await startServer({ dataDir: this.dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => logs.push(line) });
    const token = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
    await fetch(`${this.server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
    const db = new Database(join(this.dataDir, "redline.db"));
    const hash = await hashPassword(PASSWORD);
    for (const [key, name] of [["ariane", "Ariane Martin"], ["thomas", "Thomas Lefevre"], ["marc", "Marc Petit"]] as const) {
      const id = randomUUID();
      db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'member', 'active', ?, 'local')").run(id, name, `${key}@example.com`, new Date().toISOString(), hash);
      this.people[key] = { id, name, email: `${key}@example.com`, initials: name.split(" ").map((w) => w[0]).join("") };
    }
    db.close();
    this.admin = await this.signIn("vincent@example.com");
    this.ariane = await this.signIn("ariane@example.com");
    this.thomas = await this.signIn("thomas@example.com");
    this.marc = await this.signIn("marc@example.com");
    return this;
  }

  async signIn(email: string): Promise<SignedIn> {
    const response = await fetch(`${this.server.url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password: PASSWORD }) });
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    const send = (method: string, path: string, body?: unknown) =>
      fetch(this.server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    return { cookie, send, get: (path) => send("GET", path), json: async <T,>(path: string) => (await send("GET", path)).json() as Promise<T> };
  }

  async createProject(who: SignedIn, body: object = {}): Promise<Project> {
    return (await (await who.send("POST", "/api/projects", { title: "Acme", ...body })).json()) as Project;
  }

  async createPage(who: SignedIn, projectId: string, title = "Home"): Promise<string> {
    return ((await (await who.send("POST", `/api/projects/${projectId}/pages`, { title, files: FILES })).json()) as { id: string }).id;
  }

  async close(): Promise<void> {
    await this.server?.close();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}
