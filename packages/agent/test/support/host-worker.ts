import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { runAgentWorker } from "../../src/agent-worker.js";
import type { HostToWorker } from "../../src/host-protocol.js";
import type { Engine } from "../../src/engine.js";
import { FakeEngine, type FakeScript } from "./fake-engine.js";

/**
 * Worker process of the tests' agent host. REDLINE_TEST_REPORT: a file to which each start appends the config received and the
 * Claude config directory of the environment. REDLINE_TEST_ENV_REPORT: a file to which each start appends some variables of its environment. REDLINE_TEST_UPDATE_ONCE: a marker file; the first start exits with the update code.
 */
const report = process.env.REDLINE_TEST_REPORT;
const envReport = process.env.REDLINE_TEST_ENV_REPORT;
const updateOnce = process.env.REDLINE_TEST_UPDATE_ONCE;
const crash = process.env.REDLINE_TEST_CRASH;
const holdRun = process.env.REDLINE_TEST_HOLD_RUN;
const runsReport = process.env.REDLINE_TEST_RUNS;

process.on("message", (message: HostToWorker) => {
  if (message.type !== "start") return;
  if (report) appendFileSync(report, `${JSON.stringify({ claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, model: message.config.model, effort: message.config.effort, folder: message.config.folder })}\n`);
  if (envReport) appendFileSync(envReport, `${JSON.stringify({ leak: process.env.REDLINE_TEST_LEAK, apiKey: process.env.ANTHROPIC_API_KEY, awsProfile: process.env.AWS_PROFILE, path: process.env.PATH })}\n`);
  if (crash === "exit") process.exit(3);
  if (crash === "throw") setTimeout(() => { throw new Error("boom in the worker"); }, 50);
  if (crash === "stderr") {
    process.stderr.write("some noise\nfatal: the disk is full\n");
    setTimeout(() => process.exit(4), 50);
  }
  if (crash === "signal") process.kill(process.pid, "SIGKILL");
  if (updateOnce && !existsSync(updateOnce)) {
    writeFileSync(updateOnce, "");
    process.exit(75);
  }
});

/** REDLINE_TEST_HOLD_RUN: a file; a run waits, until the file is gone. REDLINE_TEST_RUNS: a file to which each run appends the model and effort it started with. */
const script: FakeScript = async (run) => {
  if (runsReport) appendFileSync(runsReport, `${JSON.stringify({ model: run.model, effort: run.effort })}\n`);
  while (holdRun && existsSync(holdRun)) await new Promise((resolve) => setTimeout(resolve, 20));
  return [
    { type: "step", tool: "Edit", summary: "home.html" },
    { edit: { path: "home.html", content: "<h1>New</h1>" } },
    { type: "result", summary: "Done" },
  ];
};

/**
 * REDLINE_TEST_CANCELLED: a file to which a run cancelled by the stop of the agent appends a line.
 * REDLINE_TEST_STEPS: a run of that many steps, then it waits until the file REDLINE_TEST_HOLD_RUN names is gone (when set) and
 * ends without editing anything.
 */
const stepCount = Number(process.env.REDLINE_TEST_STEPS ?? 0);
const cancelledReport = process.env.REDLINE_TEST_CANCELLED;
const steppingEngine: Engine = {
  async *start(request) {
    const cancelled = () => cancelledReport && appendFileSync(cancelledReport, "cancelled\n");
    // The stop may come before the engine starts: the signal is aborted already.
    if (request.signal?.aborted) cancelled();
    else request.signal?.addEventListener("abort", cancelled);
    for (let i = 1; i <= stepCount; i++) yield { type: "step", tool: "Edit", summary: `file-${i}.html` };
    while (holdRun && existsSync(holdRun)) await new Promise((resolve) => setTimeout(resolve, 20));
    yield { type: "result", summary: "" };
  },
  resume(request) {
    return this.start(request);
  },
};

runAgentWorker({ engine: stepCount > 0 ? steppingEngine : new FakeEngine(script) });
