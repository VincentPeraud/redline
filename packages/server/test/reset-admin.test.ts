import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/start.js";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const JSON_HEADERS = { "content-type": "application/json" };
const PASSWORD = "correct horse";

let dataDir: string;
let server: RunningServer | undefined;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "redline-reset-admin-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const resetAdmin = () =>
  run(process.execPath, ["--import", "tsx", main, "reset-admin"], {
    env: { ...process.env, REDLINE_DATA_DIR: dataDir, REDLINE_PUBLIC_URL: "https://redline.example.com" },
  });

const start = async (logs: string[] = []) => {
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => logs.push(line) });
  return server;
};

it("writes a password link for the existing admin, who chooses a new password with it", async () => {
  const logs: string[] = [];
  const first = await start(logs);
  const setup = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
  await fetch(`${first.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token: setup, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
  await first.close();
  server = undefined;

  const { stdout } = await resetAdmin();
  const link = stdout.match(/https:\/\/redline\.example\.com\/#\/mot-de-passe\/([A-Za-z0-9_-]+)/);
  expect(link).not.toBeNull();
  expect(stdout).toContain("vincent@example.com");

  const second = await start();
  const chosen = await fetch(`${second.url}/api/password-link`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token: link![1], password: "a brand new one" }) });
  expect(chosen.status).toBe(200);
  const signIn = (password: string) => fetch(`${second.url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email: "vincent@example.com", password }) });
  expect((await signIn(PASSWORD)).status).toBe(401);
  expect((await signIn("a brand new one")).status).toBe(200);
}, 30_000);

it("fails with a hint when the instance has no admin yet", async () => {
  await expect(resetAdmin()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("No admin account yet") });
}, 30_000);
