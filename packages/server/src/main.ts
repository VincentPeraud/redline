import { fileURLToPath } from "node:url";
import { authModeFromEnv } from "./access.js";
import { identityFromEnv } from "./identity.js";
import { proxySecretsFromEnv } from "./proxy-secrets.js";
import { publicDeadlineFromEnv } from "./public-deadline.js";
import { startServer } from "./start.js";

const server = await startServer({
  dataDir: process.env.REDLINE_DATA_DIR ?? "./data",
  host: process.env.REDLINE_HOST ?? "0.0.0.0",
  port: Number(process.env.REDLINE_PORT ?? 3000),
  artboardPort: Number(process.env.REDLINE_ARTBOARD_PORT ?? 3001),
  artboardOrigin: process.env.REDLINE_ARTBOARD_ORIGIN,
  authMode: authModeFromEnv(process.env),
  proxySecrets: proxySecretsFromEnv(process.env),
  identity: identityFromEnv(process.env),
  publicUntil: publicDeadlineFromEnv(process.env),
  cliDir: process.env.REDLINE_CLI_DIR,
  webDir: process.env.REDLINE_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});

console.log(`Redline server on ${server.url}, artboards on ${server.artboardOrigin}`);
