import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const name = `redline-backup-test-${process.pid}`;
const port = 38000 + (process.pid % 500);

// Opt-in with the other Docker tests (`npm run test:docker`): builds the image, runs real restic from its pinned image.
describe.skipIf(!process.env.REDLINE_DOCKER_TEST)("backup and restore", () => {
  let scratch: string;
  let env: NodeJS.ProcessEnv;

  const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "pipe" }).toString().trim();
  const script = (file: string, ...args: string[]) => execFileSync("bash", [join(repoRoot, "scripts", file), ...args], { env, stdio: "pipe" }).toString();

  async function waitForApi(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if ((await fetch(`http://localhost:${port}/api/projects`)).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("container did not become ready");
  }

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "redline-backup-e2e-")));
    const config = join(scratch, "config");
    mkdirSync(config, { mode: 0o700 });
    // A Docker volume rather than a host folder: restic cannot fsync a bind mount on Docker Desktop for macOS.
    writeFileSync(join(config, "repository"), `volume:${name}-repository`, { mode: 0o600 });
    writeFileSync(join(config, "password"), "test-password\n", { mode: 0o600 });
    env = { ...process.env, REDLINE_BACKUP_CONFIG_DIR: config, REDLINE_BACKUP_CONTAINER: name };
  });

  afterAll(() => {
    for (const args of [["rm", "-f", name], ["volume", "rm", "-f", name, `${name}-repository`], ["rmi", "-f", name]]) {
      try {
        docker(...args);
      } catch {
        // already gone
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("backs up a running server and the restore test finds the data", async () => {
    docker("build", "-t", name, repoRoot);
    docker("run", "-d", "--name", name, "--user", "1000:1000", "-e", "REDLINE_AUTH_MODE=none", "-v", `${name}:/data`, "-p", `${port}:3000`, name);
    await waitForApi();
    for (const title of ["First", "Second"]) {
      const created = await fetch(`http://localhost:${port}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      expect(created.status).toBe(201);
    }
    // The database also holds rows the project list hides, so count them where the script does.
    const projects = Number(
      execFileSync("docker", ["exec", "-i", name, "node", "-", "verify", "/data/redline.db"], { input: readFileSync(join(repoRoot, "scripts/backup-db.cjs")) }).toString(),
    );
    expect(projects).toBeGreaterThanOrEqual(2);

    script("backup.sh");
    const snapshots = JSON.parse(script("backup.sh", "restic", "snapshots", "--json")) as { paths: string[] }[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].paths).toContain("/data/backup/redline.db");

    expect(script("restore-test.sh", String(projects))).toContain(`${projects} project(s)`);
    expect(() => script("restore-test.sh", String(projects + 1))).toThrow();
  }, 600_000);
});
