import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const generator = join(repoRoot, "scripts/generate-secrets.sh");

describe("secret generator", () => {
  let dir: string;
  const run = (...args: string[]) =>
    execFileSync("bash", [generator, ...args], { env: { ...process.env, REDLINE_SECRETS_DIR: join(dir, "secrets") }, stdio: "pipe" });
  const envFile = () => join(dir, ".env");
  const envValue = (name: string) => readFileSync(envFile(), "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
  const secretFile = (name: string) => readFileSync(join(dir, "secrets", name), "utf8").trim();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "redline-secrets-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("creates both secrets as hex, in files and in .env, and never overwrites them", () => {
    writeFileSync(envFile(), "REDLINE_UI_HOST=ui.example.com\nREDLINE_PROXY_SECRET_HUMAN=\nREDLINE_PROXY_SECRET_MACHINE=\n");
    run(envFile());

    const human = secretFile("proxy-secret-human");
    const machine = secretFile("proxy-secret-machine");
    expect(human).toMatch(/^[0-9a-f]{64}$/);
    expect(machine).toMatch(/^[0-9a-f]{64}$/);
    expect(human).not.toBe(machine);
    expect(envValue("REDLINE_PROXY_SECRET_HUMAN")).toBe(human);
    expect(envValue("REDLINE_PROXY_SECRET_MACHINE")).toBe(machine);
    expect(envValue("REDLINE_UI_HOST")).toBe("ui.example.com");

    const before = readFileSync(envFile(), "utf8");
    run(envFile());
    expect(readFileSync(envFile(), "utf8")).toBe(before);
    expect(secretFile("proxy-secret-human")).toBe(human);
  });

  it("keeps the .env file private to its owner", () => {
    chmodSync(envFile(), 0o644);
    run(envFile());
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
  });

  it("rebuilds a missing .env line from the existing file, and a missing file from the .env line", () => {
    const human = secretFile("proxy-secret-human");
    const machine = secretFile("proxy-secret-machine");
    writeFileSync(envFile(), `REDLINE_PROXY_SECRET_MACHINE=${machine}\n`);
    rmSync(join(dir, "secrets", "proxy-secret-machine"));
    run(envFile());

    expect(envValue("REDLINE_PROXY_SECRET_HUMAN")).toBe(human);
    expect(secretFile("proxy-secret-machine")).toBe(machine);
  });

  it("refuses a secret that is not long hex and leaves it untouched", () => {
    writeFileSync(envFile(), "REDLINE_PROXY_SECRET_HUMAN=short$secret\n");
    expect(() => run(envFile())).toThrow();
    expect(envValue("REDLINE_PROXY_SECRET_HUMAN")).toBe("short$secret");
  });

  it("refuses a .env value that differs from its file", () => {
    writeFileSync(envFile(), `REDLINE_PROXY_SECRET_HUMAN=${"a".repeat(64)}\n`);
    expect(() => run(envFile())).toThrow();
  });
});

const composeFile = join(repoRoot, "docker-compose.production.yml");
const requiredEnv = {
  REDLINE_UI_HOST: "redline.example.com",
  REDLINE_ARTBOARD_HOST: "artboards.example.com",
  REDLINE_AUTH_MIDDLEWARE: "sso@docker",
  REDLINE_FIRST_ADMIN_EMAIL: "admin@example.com",
  REDLINE_PROXY_SECRET_HUMAN: "a".repeat(64),
  REDLINE_PROXY_SECRET_MACHINE: "b".repeat(64),
};

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of Object.keys(env)) {
    if (name.startsWith("REDLINE_") && !(name in extra)) delete env[name];
  }
  delete env.COMPOSE_FILE;
  return env;
}

// Opt-in with the other Docker tests: `npm run test:docker`.
describe.skipIf(!process.env.REDLINE_DOCKER_TEST)("production compose", () => {
  let scratch: string;
  let secretsDir: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "redline-prod-"));
    secretsDir = join(scratch, "secrets");
    mkdirSync(secretsDir);
    // Compose resolves `./secrets/...` against the compose file, so run from a copy of the repo's compose + Dockerfile context.
    writeFileSync(join(scratch, "docker-compose.production.yml"), readFileSync(composeFile, "utf8"));
    writeFileSync(join(secretsDir, "proxy-secret-human"), `${requiredEnv.REDLINE_PROXY_SECRET_HUMAN}\n`);
    writeFileSync(join(secretsDir, "proxy-secret-machine"), `${requiredEnv.REDLINE_PROXY_SECRET_MACHINE}\n`);
    for (const file of ["proxy-secret-human", "proxy-secret-machine"]) chmodSync(join(secretsDir, file), 0o644);
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const config = (extra: Record<string, string>) =>
    execFileSync("docker", ["compose", "-f", join(scratch, "docker-compose.production.yml"), "config", "--format", "json"], {
      cwd: scratch,
      env: cleanEnv(extra),
      stdio: "pipe",
    }).toString();

  it.each(Object.keys(requiredEnv))("refuses to start without %s", (name) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[name];
    expect(() => config(env)).toThrow();
    expect(() => config(requiredEnv)).not.toThrow();
  });

  it("declares the prefixed routers and middlewares of the spec, and publishes no port", () => {
    const service = JSON.parse(config({ ...requiredEnv, REDLINE_TRAEFIK_PREFIX: "acme" })).services.redline as {
      labels: Record<string, string>;
      ports?: unknown;
      environment: Record<string, string>;
    };
    const labels = service.labels;
    const names = (kind: "routers" | "middlewares" | "services") =>
      new Set(Object.keys(labels).filter((k) => k.startsWith(`traefik.http.${kind}.`)).map((k) => k.split(".")[3]));

    expect([...names("routers")].sort()).toEqual(
      ["acme-artboards", "acme-artboards-http", "acme-machine", "acme-share", "acme-ui", "acme-ui-http"],
    );
    expect([...names("middlewares")].sort()).toEqual(
      ["acme-body", "acme-headers", "acme-https", "acme-ratelimit", "acme-secret-human", "acme-secret-machine", "acme-strip-identity"],
    );
    expect(labels["traefik.http.routers.acme-ui.middlewares"]).toBe("acme-headers,acme-strip-identity,sso@docker,acme-body,acme-secret-human");
    // The artboard origin is guarded by the viewing capability in its URL, not by the SSO.
    expect(labels["traefik.http.routers.acme-artboards.middlewares"]).toBe("acme-headers,acme-strip-identity,acme-body,acme-secret-human");
    // Link visitors have no SSO account: `/s/*` (and the app bundle it loads) skips the SSO but keeps the human secret.
    expect(labels["traefik.http.routers.acme-share.rule"]).toBe("Host(`redline.example.com`) && (PathPrefix(`/s/`) || PathPrefix(`/assets/`))");
    expect(labels["traefik.http.routers.acme-share.middlewares"]).toBe("acme-headers,acme-strip-identity,acme-body,acme-ratelimit,acme-secret-human");
    expect(labels["traefik.http.routers.acme-share.middlewares"]).not.toContain("sso@docker");
    expect(Number(labels["traefik.http.routers.acme-share.priority"])).toBeGreaterThan(Number(labels["traefik.http.routers.acme-ui.priority"]));
    expect(labels["traefik.http.routers.acme-machine.middlewares"]).not.toContain("sso@docker");
    expect(labels["traefik.http.routers.acme-machine.middlewares"]).toContain("acme-secret-machine");
    expect(Number(labels["traefik.http.routers.acme-machine.priority"])).toBeGreaterThan(Number(labels["traefik.http.routers.acme-ui.priority"]));
    expect(labels["traefik.http.routers.acme-ui-http.service"]).toBe("noop@internal");
    expect(labels["traefik.http.middlewares.acme-secret-human.headers.customrequestheaders.X-Redline-Proxy-Secret"]).toBe(requiredEnv.REDLINE_PROXY_SECRET_HUMAN);
    expect(service.environment.REDLINE_ARTBOARD_ORIGIN).toBe("https://artboards.example.com");
    expect(service.environment.REDLINE_AUTH_MODE).toBe("proxy");
    expect(service.environment.REDLINE_PUBLIC_URL).toBe("https://redline.example.com");
    expect(service.ports).toBeUndefined();
  });
});

// Needs a Docker daemon and builds the image (slow).
describe.skipIf(!process.env.REDLINE_DOCKER_TEST)("production container", () => {
  const project = `redline-prod-test-${process.pid}`;
  const network = `${project}-net`;
  let scratch: string;

  const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "pipe" }).toString().trim();
  const compose = (...args: string[]) =>
    execFileSync("docker", ["compose", "-p", project, "-f", join(scratch, "docker-compose.production.yml"), ...args], {
      cwd: scratch,
      env: cleanEnv({ ...requiredEnv, REDLINE_TRAEFIK_NETWORK: network }),
      stdio: "pipe",
    }).toString().trim();

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "redline-prod-run-"));
    const secrets = join(scratch, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "proxy-secret-human"), `${requiredEnv.REDLINE_PROXY_SECRET_HUMAN}\n`, { mode: 0o644 });
    writeFileSync(join(secrets, "proxy-secret-machine"), `${requiredEnv.REDLINE_PROXY_SECRET_MACHINE}\n`, { mode: 0o644 });
    writeFileSync(
      join(scratch, "docker-compose.production.yml"),
      readFileSync(composeFile, "utf8").replace("build: .", `build: ${JSON.stringify(repoRoot)}`),
    );
    docker("network", "create", network);
  });
  afterAll(() => {
    try {
      compose("down", "-v", "--rmi", "local");
    } finally {
      docker("network", "rm", network);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("runs as a non-root user on a read-only root and becomes healthy", async () => {
    compose("up", "-d", "--build");
    const id = compose("ps", "-q", "redline");

    let status = "";
    for (let attempt = 0; attempt < 60 && status !== "healthy"; attempt++) {
      status = docker("inspect", "-f", "{{.State.Health.Status}}", id);
      if (status !== "healthy") await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(status).toBe("healthy");

    expect(docker("exec", id, "id", "-u")).not.toBe("0");
    expect(docker("inspect", "-f", "{{.HostConfig.ReadonlyRootfs}}", id)).toBe("true");
    expect(() => docker("exec", id, "sh", "-c", "touch /app/should-fail")).toThrow();
    expect(docker("inspect", "-f", "{{.HostConfig.CapDrop}}", id)).toContain("ALL");
  }, 300_000);
});
