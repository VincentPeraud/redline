import { startAgentHost } from "../../src/agent-host.js";
import { hostWorkerCommand } from "./host-launch.js";

/** A host in its own process, as `redline host` runs it: the tests start it detached through `ensureHost`. */
const host = await startAgentHost({ configDir: process.env.REDLINE_CONFIG_DIR!, worker: hostWorkerCommand(), idleExitMs: 300 });
await host.closed;
