import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { runAgentWorker } from "../../src/agent-worker.js";
import type { HostToWorker } from "../../src/host-protocol.js";
import { FakeEngine } from "./fake-engine.js";

/**
 * Worker process of the tests' agent host. REDLINE_TEST_REPORT: a file to which each start appends the config received and the
 * Claude config directory of the environment. REDLINE_TEST_UPDATE_ONCE: a marker file; the first start exits with the update code.
 */
const report = process.env.REDLINE_TEST_REPORT;
const updateOnce = process.env.REDLINE_TEST_UPDATE_ONCE;

process.on("message", (message: HostToWorker) => {
  if (message.type !== "start") return;
  if (report) appendFileSync(report, `${JSON.stringify({ claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, model: message.config.model, effort: message.config.effort, folder: message.config.folder })}\n`);
  if (updateOnce && !existsSync(updateOnce)) {
    writeFileSync(updateOnce, "");
    process.exit(75);
  }
});

runAgentWorker({ engine: new FakeEngine([{ type: "result", summary: "Done" }]) });
