import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const backupScript = join(repoRoot, "scripts/backup.sh");
const dbHelper = join(repoRoot, "scripts/backup-db.cjs");

describe("backup-db helper", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "redline-backup-db-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const helper = (...args: string[]) => run("node", [dbHelper, ...args], { cwd: repoRoot });

  it("copies a live database consistently and reports its project count", async () => {
    const source = join(dir, "source");
    mkdirSync(source);
    const store = new Store(source);
    store.createProject("One");
    store.createProject("Two");

    const copy = join(dir, "copy.db");
    const { stdout } = await helper("snapshot", join(source, "redline.db"), copy);
    const live = (new Database(join(source, "redline.db"), { readonly: true }).prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(live).toBeGreaterThanOrEqual(2);
    expect(stdout.trim()).toBe(String(live));
    expect(new Database(copy, { readonly: true }).prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: live });
  });

  it("refuses a corrupt database and keeps the previous copy", async () => {
    const corrupt = join(dir, "corrupt.db");
    writeFileSync(corrupt, Buffer.alloc(8192, 7));
    await expect(helper("verify", corrupt)).rejects.toThrow();

    const copy = join(dir, "previous.db");
    writeFileSync(copy, "previous");
    await expect(helper("snapshot", corrupt, copy)).rejects.toThrow();
    expect(readFileSync(copy, "utf8")).toBe("previous");
    expect(existsSync(`${copy}.partial`)).toBe(false);
  });

  it("refuses a database without Redline's tables", async () => {
    const other = join(dir, "other.db");
    const db = new Database(other);
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();
    await expect(helper("verify", other)).rejects.toThrow(/missing tables/);
  });
});

describe("backup.sh", () => {
  let scratch: string;
  let configDir: string;
  let dockerLog: string;
  let env: NodeJS.ProcessEnv;
  let hooks: Server;
  let hookBodies: { path: string; body: string }[];
  let hookUrl: string;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "redline-backup-script-"));
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    dockerLog = join(scratch, "docker.log");
    // Stand-in for docker: logs every call; `exec ... node` plays the database copy and fails when asked to.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
echo "$@" >> "${dockerLog}"
case "$1" in
  inspect) echo fake-volume ;;
  exec)
    case "$*" in
      *" node "*) cat > /dev/null; if [ -n "$FAKE_SNAPSHOT_FAILS" ]; then echo "integrity_check failed" >&2; exit 1; fi; echo 3 ;;
    esac ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    hookBodies = [];
    hooks = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk));
      request.on("end", () => {
        hookBodies.push({ path: request.url ?? "", body });
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => hooks.listen(0, "127.0.0.1", resolve));
    hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}`;
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REDLINE_BACKUP_CONTAINER: "fake-container" };
  });
  afterAll(async () => {
    await new Promise((resolve) => hooks.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  beforeEach(() => {
    hookBodies = [];
    writeFileSync(dockerLog, "");
    configDir = join(scratch, "config");
    rmSync(configDir, { recursive: true, force: true });
    mkdirSync(configDir, { mode: 0o700 });
    writeFileSync(join(configDir, "repository"), "/srv/restic-repo\n", { mode: 0o600 });
    writeFileSync(join(configDir, "password"), "secret\n", { mode: 0o600 });
    writeFileSync(join(configDir, "webhook-success"), `${hookUrl}/success\n`, { mode: 0o600 });
    writeFileSync(join(configDir, "webhook-failure"), `${hookUrl}/failure\n`, { mode: 0o600 });
    env.REDLINE_BACKUP_CONFIG_DIR = configDir;
    delete env.FAKE_SNAPSHOT_FAILS;
  });

  const backup = (...args: string[]) => run("bash", [backupScript, ...args], { env, cwd: scratch });
  const dockerCalls = () => readFileSync(dockerLog, "utf8").split("\n").filter(Boolean);
  const resticCalls = () => dockerCalls().filter((call) => call.startsWith("run "));

  it("backs up, applies retention and calls the success webhook", async () => {
    await backup();

    const restic = resticCalls();
    expect(restic.some((call) => call.includes(" backup --host redline "))).toBe(true);
    expect(restic.some((call) => call.includes(" forget ") && call.includes("--keep-daily 7") && call.endsWith("--prune"))).toBe(true);
    expect(restic.every((call) => call.includes("restic/restic@sha256:"))).toBe(true);
    expect(restic.find((call) => call.includes(" backup "))).toContain("-v fake-volume:/data:ro");
    expect(hookBodies).toEqual([{ path: "/success", body: expect.stringContaining('"text"') }]);
    expect(JSON.parse(hookBodies[0].body).text).toContain("3 project(s)");
    expect(readFileSync(join(configDir, "logs", `backup-${new Date().toISOString().slice(0, 10)}.log`), "utf8")).toContain("Backup finished");
  });

  it("stops before restic when the database copy fails its checks, and calls the failure webhook", async () => {
    env.FAKE_SNAPSHOT_FAILS = "1";
    await expect(backup()).rejects.toThrow();

    expect(resticCalls()).toEqual([]);
    expect(hookBodies.map((hook) => hook.path)).toEqual(["/failure"]);
    expect(JSON.parse(hookBodies[0].body).text).toContain("consistent copy of the database");
  });

  it.each([
    ["the folder", () => chmodSync(configDir, 0o750)],
    ["the password file", () => chmodSync(join(configDir, "password"), 0o640)],
  ])("refuses to run when %s is readable by group or others", async (_name, loosen) => {
    loosen();
    await expect(backup()).rejects.toThrow(/Refusing to run/);

    expect(dockerCalls()).toEqual([]);
    expect(hookBodies).toEqual([]);
  });

  it("refuses to run while another backup holds the lock", async () => {
    mkdirSync(join(configDir, "backup.lock"), { mode: 0o700 });
    writeFileSync(join(configDir, "backup.lock", "pid"), String(process.pid), { mode: 0o600 });
    await expect(backup()).rejects.toThrow(/Another backup is running/);
    expect(dockerCalls()).toEqual([]);
  });

  it("passes `restic <args>` through to the pinned image with the current folder mounted", async () => {
    await backup("restic", "snapshots", "--json");

    const [call] = resticCalls();
    expect(call).toContain(`-v ${realpathSync(scratch)}:/restore -w /restore`);
    expect(call).toContain("-v /srv/restic-repo:/repository");
    expect(call).toContain("RESTIC_REPOSITORY=/repository");
    expect(call).toMatch(/restic\/restic@sha256:[0-9a-f]{64} snapshots --json$/);
    expect(hookBodies).toEqual([]);
  });
});
