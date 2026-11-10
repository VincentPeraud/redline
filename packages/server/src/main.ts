import { fileURLToPath } from "node:url";
import { resolveAuthMode } from "./access.js";
import { identityFromEnv } from "./identity.js";
import { proxySecretsFromEnv } from "./proxy-secrets.js";
import { publicDeadlineFromEnv } from "./public-deadline.js";
import { resetAdmin } from "./reset-admin.js";
import { startServer } from "./start.js";

if (process.argv[2] === "reset-admin") {
  process.exit(resetAdmin({ dataDir: process.env.REDLINE_DATA_DIR ?? "./data", publicUrl: process.env.REDLINE_PUBLIC_URL, log: console.log, error: console.error }));
}

const proxySecrets = proxySecretsFromEnv(process.env);
const server = await startServer({
  dataDir: process.env.REDLINE_DATA_DIR ?? "./data",
  host: process.env.REDLINE_HOST ?? "0.0.0.0",
  port: Number(process.env.REDLINE_PORT ?? 3000),
  artboardPort: Number(process.env.REDLINE_ARTBOARD_PORT ?? 3001),
  artboardOrigin: process.env.REDLINE_ARTBOARD_ORIGIN,
  authMode: resolveAuthMode(process.env, proxySecrets),
  proxySecrets,
  publicUrl: process.env.REDLINE_PUBLIC_URL,
  firstAdminEmail: process.env.REDLINE_FIRST_ADMIN_EMAIL,
  trustedProxy: ["1", "true"].includes((process.env.REDLINE_TRUSTED_PROXY ?? "").toLowerCase()),
  identity: identityFromEnv(process.env),
  publicUntil: publicDeadlineFromEnv(process.env),
  cliDir: process.env.REDLINE_CLI_DIR,
  webDir: process.env.REDLINE_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});

console.log(`Redline server on ${server.url}, artboards on ${server.artboardOrigin}`);
