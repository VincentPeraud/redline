import { describe, expect, it } from "vitest";
import { applyEvent, closeSummary, initialState, logLoaded, newAgentFailed, newAgentQuestions, onKey, plainText, render, tick, type ScreenState } from "../src/agents-view.js";
import { runAgentsScreen, type ScreenHost, type ScreenTerminal } from "../src/agents-screen.js";
import type { Effort } from "@redline/shared";
import type { HostAgent, HostEvent, HostLogEntry, HostLogEvent } from "../src/host-protocol.js";
import type { NewAgentAnswers, NewAgentFlow, NewAgentQuestions, ProjectOption } from "../src/new-agent.js";

const NOW = Date.parse("2026-10-28T16:12:00");
const entry = (time: string, event: HostLogEvent): HostLogEntry => ({ at: new Date(`2026-10-28T${time}`).toISOString(), event });

const agent = (over: Partial<HostAgent> & Pick<HostAgent, "id" | "name">): HostAgent => ({
  folder: `/Users/vincent/claude-projects/${over.name}`,
  kind: "project",
  serverUrl: "https://redline.brightco.fr",
  claudeConfigDir: "/Users/vincent/.claude",
  account: "contact@brightco.fr",
  projectNames: ["Lumora", "Lumora Pro"],
  model: "opus",
  effort: "medium",
  machine: "MacBook-Pro",
  state: "idle",
  since: new Date("2026-10-28T13:58:02").toISOString(),
  startedAt: new Date(NOW - (2 * 60 + 14) * 60_000).toISOString(),
  ...over,
});

const lumora = agent({ id: "a1", name: "lumora", state: "running", run: { page: "Tarifs", pageId: "p1" } });
const radio = agent({ id: "a2", name: "radio-haidf", model: "sonnet", effort: "high", projectNames: ["Radio HAIDF"] });
const portfolio = agent({ id: "a4", name: "portfolio", model: "haiku", effort: "low", state: "stopped" });

const lumoraLog: HostLogEntry[] = [
  entry("13:58:02", { type: "connected", serverUrl: "https://redline.brightco.fr", kind: "project", folder: "/x" }),
  entry("14:05:40", { type: "run-started", workId: "w1", project: "Lumora", page: "Accueil", kind: "comment", author: "Vincent", excerpt: "Le titre du hero est trop gros sur mobile", attempt: 1 }),
  entry("14:06:57", { type: "run-published", workId: "w1", page: "Accueil", changed: ["home.html", "m.html"], durationMs: 77_000 }),
  entry("14:09:12", { type: "run-failed", workId: "w2", page: "Onboarding", reason: "Claude hit its usage limit", attempt: 1 }),
  entry("14:11:30", { type: "connection-lost" }),
  entry("14:11:32", { type: "reconnected" }),
  entry("14:12:03", { type: "run-started", workId: "w3", project: "Lumora Pro", page: "Tarifs", kind: "conversation", author: "Vincent", attempt: 1 }),
  entry("14:12:10", { type: "run-progress", workId: "w3", steps: ["Read DESIGN.md"], elapsedMs: 7000 }),
  entry("14:12:31", { type: "run-progress", workId: "w3", steps: ["Edit Tarifs.dc.html", "Read DESIGN.md"], elapsedMs: 28_000 }),
];

function open(agents: HostAgent[], selectedId?: string, logs: Record<string, HostLogEntry[]> = { a1: lumoraLog }, freshStartAt?: string): ScreenState {
  let state = initialState({ agents, selectedId, now: NOW, home: "/Users/vincent", folder: FOLDER, freshStartAt });
  for (const [id, entries] of Object.entries(logs)) state = logLoaded(state, id, entries);
  return state;
}
const text = (state: ScreenState, columns = 184, rows = 43) => plainText(render(state, { columns, rows })).join("\n");
const press = (state: ScreenState, ...keys: string[]) => keys.reduce((s, k) => onKey(s, k).state, state);

describe("the agents screen's view", () => {
  it("shows the header, the selected agent's detail, the run log and the agent list", () => {
    const frame = text(open([lumora, radio, agent({ id: "a3", name: "global", kind: "global", projectNames: undefined, effort: undefined }), portfolio]));
    expect(frame).toContain("redline agents  https://redline.brightco.fr");
    expect(frame).toContain("4 agents · 1 run in progress");
    expect(frame).toMatch(/lumora {2}~\/claude-projects\/lumora +● running · Lumora Pro \/ Tarifs/);
    expect(frame).toContain("Projects  Lumora, Lumora Pro");
    expect(frame).toContain("Model     Opus");
    expect(frame).toContain("Effort    medium");
    expect(frame).toContain("Account   contact@brightco.fr");
    expect(frame).toContain("Machine   MacBook-Pro · up 2 h 14 min");
    expect(frame).toContain("13:58:02  Connected to https://redline.brightco.fr as project agent.");
    expect(frame).toContain("14:05:40  ▸ Run started  Lumora / Accueil  comment by Vincent");
    expect(frame).toContain("« Le titre du hero est trop gros sur mobile »");
    expect(frame).toContain("14:06:57  ✓ Published  Lumora / Accueil  2 files changed · 1 min 17 s");
    expect(frame).toContain("14:09:12  ✗ Run failed  Onboarding  Claude hit its usage limit");
    expect(frame).toContain("14:11:30  Connection lost, retrying...");
    expect(frame).toContain("14:11:32  Connected again.");
    expect(frame).toContain("14:12:03  ▸ Run started  Lumora Pro / Tarifs  conversation with Vincent");
    expect(frame).toContain("Edit Tarifs.dc.html · Read DESIGN.md · 1 h 59 min");
    expect(frame).not.toContain("Read DESIGN.md · 7 s");
    expect(frame).toContain("› ● lumora"+" ".repeat(11)+"running");
    expect(frame).toContain("Opus · medium");
    expect(frame).toContain("radio-haidf"+" ".repeat(9)+"idle");
    expect(frame).toContain("Sonnet · high");
    expect(frame).toContain("Opus · Claude's default");
    expect(frame).toContain("○ portfolio"+" ".repeat(8)+"stopped");
    expect(frame).toContain("Haiku · low");
    expect(frame).toMatch(/↑↓ +agent/);
    expect(frame).toMatch(/ q +close · agents keep running/);
  });

  it("changes the detail and the highlighted row with ↑ and ↓, and stops at the ends", () => {
    const state = open([lumora, radio, portfolio]);
    const down = press(state, "down");
    expect(text(down)).toContain("radio-haidf  ~/claude-projects/radio-haidf");
    expect(text(down)).toContain("› ● radio-haidf");
    expect(text(down)).toContain("Projects  Radio HAIDF");
    expect(text(down)).not.toContain("› ● lumora");
    expect(text(press(down, "up", "up"))).toContain("› ● lumora");
    expect(text(press(state, "down", "down", "down", "down"))).toContain("› ○ portfolio");
  });

  it("shows a stopped agent without uptime, and the time it stopped", () => {
    const frame = text(open([portfolio], "a4", { a4: [] }));
    expect(frame).toContain("○ stopped since 13:58");
    expect(frame).toMatch(/Machine {3}MacBook-Pro(?! · up)/);
    expect(frame).toContain("all stopped");
  });

  it("shows an empty state when no agent exists", () => {
    const frame = text(open([]));
    expect(frame).toContain("0 agents");
    expect(frame).toContain("No agent yet. Press n to start one in this folder.");
  });

  it("adds a new log line without a key press", () => {
    let state = open([lumora, radio]);
    state = applyEvent(state, { event: "log-line", agentId: "a1", entry: entry("14:13:00", { type: "run-published", workId: "w3", page: "Tarifs", changed: [], durationMs: 52_000 }) });
    const frame = text(state);
    expect(frame).toContain("14:13:00  ✓ Finished  Lumora Pro / Tarifs  nothing changed · 52 s");
    expect(frame).not.toContain("Edit Tarifs.dc.html · Read DESIGN.md");
  });

  it("follows agent changes, additions and removals", () => {
    let state = open([lumora, radio]);
    state = applyEvent(state, { event: "agent-changed", agent: { ...radio, state: "reconnecting" } });
    expect(text(state)).toContain("reconnecting");
    state = applyEvent(state, { event: "agent-added", agent: portfolio });
    expect(text(state)).toContain("3 agents");
    state = applyEvent(state, { event: "agent-removed", agentId: "a1" });
    expect(text(state)).toContain("2 agents");
    expect(text(state)).toContain("› ● radio-haidf");
  });

  it("keeps the log lines that arrived before the log was loaded, without duplicating them", () => {
    let state = open([lumora], undefined, {});
    const late = entry("14:13:00", { type: "reconnected" });
    state = applyEvent(state, { event: "log-line", agentId: "a1", entry: late });
    state = logLoaded(state, "a1", [...lumoraLog, late]);
    expect(text(state).match(/14:13:00/g)).toHaveLength(1);
  });

  it("keeps the latest log lines when they do not all fit", () => {
    const frame = text(open([lumora]), 184, 20);
    expect(frame).not.toContain("13:58:02");
    expect(frame).toContain("Edit Tarifs.dc.html");
  });

  it("counts uptime from the clock", () => {
    const state = tick(open([lumora]), NOW + 60_000);
    expect(text(state)).toContain("up 2 h 15 min");
  });

  it("closes on q and Ctrl-C, and summarises the agents that keep running", () => {
    const state = open([lumora, radio, portfolio]);
    for (const key of ["q", "ctrl-c"]) expect(onKey(state, key).commands).toEqual([{ type: "close" }]);
    expect(onKey(state, "down").commands).toEqual([]);
    expect(plainText(closeSummary(state))).toEqual([
      "Screen closed. 2 agents keep running in the background:",
      "  ● lumora       running · Lumora Pro / Tarifs",
      "  ● radio-haidf  idle",
      "  ○ portfolio    stopped",
      "Run redline agents to see them again.",
    ]);
  });

  it("draws exactly the terminal's rows and columns", () => {
    for (const [columns, rows] of [[184, 43], [100, 30], [80, 24]] as const) {
      const lines = plainText(render(open([lumora, radio, portfolio]), { columns, rows }));
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect([...line]).toHaveLength(columns);
    }
  });
});

describe("stopping, removing and restarting from the view", () => {
  const board = () => open([lumora, radio, agent({ id: "a3", name: "global", kind: "global", projectNames: undefined, effort: undefined }), portfolio]);
  const stoppedAgent = (a: HostAgent): HostAgent => ({ ...a, state: "stopped", run: undefined, since: new Date("2026-10-28T18:42:10").toISOString() });
  const allStopped = (freshStartAt?: string) => open([lumora, radio, portfolio].map(stoppedAgent), "a1", { a1: lumoraLog }, freshStartAt);

  it("asks before stopping an agent that is running a run, and says what stopping does", () => {
    const asked = onKey(tick(board(), Date.parse("2026-10-28T14:12:31")), "x");
    expect(asked.commands).toEqual([]);
    const frame = text(asked.state);
    expect(frame).toContain("Stop lumora?");
    expect(frame).toContain("A run is in progress on Lumora Pro / Tarifs (28 s).");
    expect(frame).toContain("Stopping cancels it; the conversation stays open in Redline.");
    expect(frame).toContain("The agent stays in the list as stopped: r restarts it, x again removes it.");
    expect(frame).toMatch(/ y {2}stop {4}Esc {2}keep running/);
  });

  it("stops on y, keeps the agent running on Esc, and ignores other keys while the dialog is open", () => {
    const asked = onKey(board(), "x").state;
    expect(onKey(asked, "y").commands).toEqual([{ type: "stop", agentId: "a1" }]);
    expect(text(onKey(asked, "y").state)).not.toContain("Stop lumora?");
    const kept = onKey(asked, "escape");
    expect(kept.commands).toEqual([]);
    expect(text(kept.state)).not.toContain("Stop lumora?");
    for (const key of ["down", "q", "r", "x", "n"]) {
      const ignored = onKey(asked, key);
      expect(ignored.commands).toEqual([]);
      expect(text(ignored.state)).toContain("Stop lumora?");
    }
  });

  it("stops an agent that is not in a run at once, without a dialog", () => {
    const idle = onKey(open([radio], "a2"), "x");
    expect(idle.commands).toEqual([{ type: "stop", agentId: "a2" }]);
    expect(text(idle.state)).not.toContain("Stop radio-haidf?");
  });

  it("closes the dialog when the run ends or the agent goes away while it is open", () => {
    const asked = onKey(board(), "x").state;
    const done = applyEvent(asked, { event: "agent-changed", agent: { ...lumora, state: "idle", run: undefined } });
    expect(text(done)).not.toContain("Stop lumora?");
    expect(text(applyEvent(asked, { event: "agent-removed", agentId: "a1" }))).not.toContain("Stop lumora?");
  });

  it("dims the screen behind the dialog", () => {
    const lines = render(onKey(board(), "x").state, { columns: 184, rows: 43 });
    expect(lines[0]).toContain("48;2;11;11;12;");
    expect(lines[0]).not.toContain("48;2;24;24;27;");
  });

  it("removes a stopped agent on x, and shows the stopped agent's keys on the bar", () => {
    const state = open([lumora, radio, portfolio], "a4");
    expect(onKey(state, "x").commands).toEqual([{ type: "remove", agentId: "a4" }]);
    const frame = text(state);
    expect(frame).toMatch(/↑↓ +agent +r +restart +R +restart all +n +new agent here +m +model\/effort +x +remove +q +close\s/);
    expect(frame).not.toContain("close · agents keep running");
    expect(text(open([lumora, radio, portfolio], "a1"))).toMatch(/↑↓ +agent +n +new agent here +m +model\/effort +o +open in Redline +x +stop +q +close · agents keep running/);
    expect(text(open([lumora, radio, portfolio], "a1"))).not.toMatch(/restart all/);
  });

  it("restarts the selected stopped agent on r, and every stopped agent on R only when some exist", () => {
    const stopped = open([lumora, radio, portfolio], "a4");
    expect(onKey(stopped, "r").commands).toEqual([{ type: "restart", agentId: "a4" }]);
    expect(onKey(stopped, "R").commands).toEqual([{ type: "restart-all" }]);
    const running = open([lumora, radio, portfolio], "a1");
    expect(onKey(running, "r").commands).toEqual([]);
    expect(onKey(running, "R").commands).toEqual([{ type: "restart-all" }]);
    const none = open([lumora, radio], "a1");
    expect(onKey(none, "R").commands).toEqual([]);
  });

  it("shows the banner when every agent is stopped after a fresh start, and the log's stop line", () => {
    const log = [...lumoraLog, entry("18:42:10", { type: "stopped", reason: "host-restarted" })];
    let state = logLoaded(allStopped(new Date("2026-10-28T18:42:10").toISOString()), "a1", log);
    const frame = text(state);
    expect(frame).toContain("○ The agents stopped (the Mac restarted or the session closed at 18:42).");
    expect(frame).toContain("r restarts the selected one with the same folder, model and effort · R restarts all.");
    expect(frame).toContain("○ stopped since 18:42");
    expect(frame).toContain("3 agents · all stopped");
    expect(frame).toContain("18:42:10  ○ Stopped  the Mac restarted or the session closed");
    state = applyEvent(state, { event: "agent-changed", agent: { ...stoppedAgent(lumora), state: "reconnecting" } });
    expect(text(state)).toContain("The agents stopped");
    state = applyEvent(state, { event: "fresh-start" });
    expect(text(state)).not.toContain("The agents stopped");
  });

  it("shows no banner without a fresh start, or once no agent is stopped; an agent launched since does not hide it", () => {
    expect(text(allStopped())).not.toContain("The agents stopped");
    expect(text(open([lumora, portfolio], "a4", {}, new Date().toISOString()))).toContain("The agents stopped");
    expect(text(open([lumora, radio], "a1", {}, new Date().toISOString()))).not.toContain("The agents stopped");
  });
});

describe("the elapsed time of the run in progress", () => {
  it("counts from the start of the run and the screen's clock, not from the last step", () => {
    const state = open([lumora]);
    const at = (time: string) => text(tick(state, Date.parse(`2026-10-28T${time}`)));
    expect(at("14:12:31")).toContain("Edit Tarifs.dc.html · Read DESIGN.md · 28 s");
    expect(at("14:12:41")).toContain("Edit Tarifs.dc.html · Read DESIGN.md · 38 s");
    expect(at("14:13:41")).toContain("Edit Tarifs.dc.html · Read DESIGN.md · 1 min 38 s");
  });

  it("keeps only the latest progress of a run when lines stream in", () => {
    let state = open([lumora]);
    const before = state.logs.a1.length; // two progress lines of the run: the next one replaces both
    for (const [time, step] of [["14:12:40", "Step A"], ["14:12:50", "Step B"]]) {
      state = applyEvent(state, { event: "log-line", agentId: "a1", entry: entry(time, { type: "run-progress", workId: "w3", steps: [step], elapsedMs: 1 }) });
    }
    expect(state.logs.a1).toHaveLength(before - 1);
    expect(text(state)).toContain("Step B");
    expect(text(state)).not.toContain("Step A");
  });

  it("redraws every second so a run's time moves, and only when the picture changed", async () => {
    const host = new FakeHost([lumora], { a1: lumoraLog });
    const terminal = new FakeTerminal();
    let clock = Date.parse("2026-10-28T14:12:31");
    const done = runAgentsScreen({ host, terminal, now: () => clock, home: "/Users/vincent", folder: FOLDER, newAgent: new FakeFlow(), openUrl: () => undefined, tickMs: 20 });
    await settle();
    expect(terminal.frame).toContain("· 28 s");
    const drawn = terminal.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(terminal.frames.length).toBe(drawn);
    clock += 5_000;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(terminal.frame).toContain("· 33 s");
    terminal.keyListener("q");
    await done;
  });
});

describe("changing the model and effort from the view", () => {
  const board = () => open([lumora, radio, portfolio]);

  it("opens on m with the agent's model and effort preselected, and the field and choice keys on the bar", () => {
    const frame = text(onKey(board(), "m").state);
    expect(frame).toContain("Model and effort  · lumora");
    expect(frame).toMatch(/Model {6}opus {3}sonnet {3}haiku/);
    expect(frame).toMatch(/Effort {5}default {3}low {3}medium {3}high {3}xhigh {3}max/);
    expect(frame).toMatch(/↑↓ +field +←→ +choice +Enter +apply +Esc +cancel/);
    const lines = render(onKey(board(), "m").state, { columns: 184, rows: 43 });
    const modelLine = lines.find((line) => plainText([line])[0].includes("Model      opus"))!;
    expect(modelLine).toContain("48;2;228;228;231;38;2;24;24;27;1m opus ");
    const effortLine = lines.find((line) => plainText([line])[0].includes("Effort     default"))!;
    expect(effortLine).toContain("48;2;161;161;170;38;2;24;24;27;1m medium ");
  });

  it("moves between fields with ↑↓ and between choices with ←→, stopping at the ends, and applies on Enter", () => {
    let state = onKey(board(), "m").state;
    state = press(state, "right");
    expect(text(state)).toContain("Opus · medium");
    state = press(state, "right", "right", "right");
    expect(onKey(state, "enter").commands).toEqual([{ type: "set-model-effort", agentId: "a1", model: "haiku", effort: "medium" }]);
    state = press(state, "down", "right", "right");
    expect(onKey(state, "enter").commands).toEqual([{ type: "set-model-effort", agentId: "a1", model: "haiku", effort: "xhigh" }]);
    state = press(state, "left", "left", "left", "left", "left");
    expect(onKey(state, "enter").commands).toEqual([{ type: "set-model-effort", agentId: "a1", model: "haiku", effort: undefined }]);
    expect(text(onKey(state, "enter").state)).not.toContain("Model and effort");
  });

  it("changes nothing on Esc, and sends nothing when nothing was changed", () => {
    const changed = press(onKey(board(), "m").state, "right", "down", "right");
    const cancelled = onKey(changed, "escape");
    expect(cancelled.commands).toEqual([]);
    expect(text(cancelled.state)).not.toContain("Model and effort");
    expect(onKey(onKey(board(), "m").state, "enter").commands).toEqual([]);
  });

  it("offers a full model id the agent runs with", () => {
    const frame = text(onKey(open([agent({ id: "a9", name: "custom", model: "claude-opus-5-5" })], "a9"), "m").state);
    expect(frame).toMatch(/Model {6}opus {3}sonnet {3}haiku {3}claude-opus-5-5/);
  });

  it("says a run in progress finishes with the old settings, and only then", () => {
    const running = text(tick(onKey(board(), "m").state, NOW));
    expect(running).toContain("! A run is in progress (Lumora Pro / Tarifs): it finishes with Opus · medium.");
    expect(running).toContain("The new choice applies from the next run, without restarting the agent.");
    const idle = text(onKey(open([radio, lumora], "a2"), "m").state);
    expect(idle).not.toContain("A run is in progress");
  });

  it("follows the agent's run while open, and closes when the agent goes away", () => {
    const opened = onKey(open([radio]), "m").state;
    const started = applyEvent(opened, { event: "agent-changed", agent: { ...radio, state: "running", run: { page: "Tarifs", pageId: "p1" } } });
    expect(text(started)).toContain("it finishes with Sonnet · high.");
    expect(text(applyEvent(started, { event: "agent-changed", agent: radio }))).not.toContain("A run is in progress");
    expect(text(applyEvent(opened, { event: "agent-removed", agentId: "a2" }))).not.toContain("Model and effort");
  });

  it("also works on a stopped agent, and ignores other keys while open", () => {
    const stopped = onKey(open([portfolio]), "m").state;
    expect(text(stopped)).toContain("Model and effort  · portfolio");
    for (const key of ["q", "x", "y", "n"]) expect(onKey(stopped, key).commands).toEqual([]);
    expect(text(onKey(stopped, "q").state)).toContain("Model and effort");
  });

  it("shows the new values in the list and detail once the host reports them", () => {
    const applied = applyEvent(board(), { event: "agent-changed", agent: { ...lumora, model: "sonnet", effort: "high" } });
    const frame = text(applied);
    expect(frame).toContain("Model     Sonnet");
    expect(frame).toContain("Effort    high");
    expect(frame).toMatch(/lumora +running +\n.*Sonnet · high/);
  });
});

class FakeHost implements ScreenHost {
  listener: ((event: HostEvent) => void) | undefined;
  calls: string[] = [];
  constructor(readonly agents: HostAgent[], readonly logs: Record<string, HostLogEntry[]>, readonly freshStartAt?: string) {}
  async snapshot() { return { agents: this.agents, freshStartAt: this.freshStartAt }; }
  async log(agentId: string) { return this.logs[agentId] ?? []; }
  async subscribe(listener: (event: HostEvent) => void) { this.listener = listener; }
  private change(id: string, change: Partial<HostAgent>) {
    const current = this.agents.find((a) => a.id === id)!;
    this.listener!({ event: "agent-changed", agent: { ...current, ...change } });
  }
  async stop(agentId: string) { this.calls.push(`stop ${agentId}`); this.change(agentId, { state: "stopped", run: undefined }); return this.agents.find((a) => a.id === agentId)!; }
  async remove(agentId: string) { this.calls.push(`remove ${agentId}`); this.listener!({ event: "agent-removed", agentId }); }
  async restart(agentId: string) { this.calls.push(`restart ${agentId}`); this.change(agentId, { state: "reconnecting" }); return { agent: this.agents.find((a) => a.id === agentId)!, started: true }; }
  async setModelEffort(agentId: string, choice: { model: string; effort?: Effort }) {
    this.calls.push(`set ${agentId} ${choice.model} ${choice.effort ?? "default"}`);
    this.change(agentId, choice);
    return this.agents.find((a) => a.id === agentId)!;
  }
  async restartAll() {
    this.calls.push("restart-all");
    const stopped = this.agents.filter((a) => a.state === "stopped");
    for (const a of stopped) this.change(a.id, { state: "reconnecting" });
    return stopped;
  }
}

class FakeTerminal implements ScreenTerminal {
  frames: string[][] = [];
  keyListener: (key: string) => void = () => undefined;
  resizeListener: () => void = () => undefined;
  closed = false;
  columns = 184;
  rows = 43;
  size() { return { columns: this.columns, rows: this.rows }; }
  draw(lines: string[]) { this.frames.push(lines); }
  onKey(listener: (key: string) => void) { this.keyListener = listener; }
  onResize(listener: () => void) { this.resizeListener = listener; }
  close() { this.closed = true; }
  get frame() { return plainText(this.frames.at(-1)!).join("\n"); }
}
const FOLDER = "/Users/vincent/claude-projects/cv";

class FakeFlow implements NewAgentFlow {
  questions: NewAgentQuestions = { servers: ["https://redline.brightco.fr"], serverUrl: "https://redline.brightco.fr", projects: [{ id: "p1", title: "Lumora" }, { id: "p2", title: "Radio HAIDF" }], model: "opus", effort: "medium" };
  projectsByServer: Record<string, ProjectOption[]> = {};
  started: NewAgentAnswers[] = [];
  failWith?: string;
  agent?: HostAgent;
  async inspect() { return this.questions; }
  async projectsOf(serverUrl: string) { return this.projectsByServer[serverUrl] ?? []; }
  async start(answers: NewAgentAnswers) {
    this.started.push(answers);
    if (this.failWith) throw new Error(this.failWith);
    return this.agent!;
  }
}
const stoppedOf = (a: HostAgent): HostAgent => ({ ...a, state: "stopped", run: undefined });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the agents screen over a host client", () => {
  const start = async (host: FakeHost, selectedId?: string) => {
    const terminal = new FakeTerminal();
    const flow = new FakeFlow();
    const opened: string[] = [];
    const done = runAgentsScreen({ host, terminal, selectedId, now: () => NOW, home: "/Users/vincent", folder: FOLDER, newAgent: flow, openUrl: (url) => opened.push(url), tickMs: 1_000_000 });
    await settle();
    return { terminal, done, flow, opened };
  };

  it("opens on the requested agent with its log, follows live lines, and resolves with the final state on q", async () => {
    const host = new FakeHost([lumora, radio], { a1: lumoraLog });
    const { terminal, done } = await start(host, "a2");
    expect(terminal.frame).toContain("› ● radio-haidf");
    terminal.keyListener("up");
    expect(terminal.frame).toContain("Edit Tarifs.dc.html · Read DESIGN.md · 1 h 59 min");
    host.listener!({ event: "log-line", agentId: "a1", entry: entry("14:13:00", { type: "reconnected" }) });
    expect(terminal.frame).toContain("14:13:00  Connected again.");
    terminal.keyListener("q");
    const closed = await done;
    expect(terminal.closed).toBe(true);
    expect(plainText(closeSummary(closed))[0]).toBe("Screen closed. 2 agents keep running in the background:");
  });

  it("stops a running agent after the confirmation, and keeps it running on Esc", async () => {
    const host = new FakeHost([lumora, radio], { a1: lumoraLog });
    const { terminal, done } = await start(host);
    terminal.keyListener("x");
    terminal.keyListener("escape");
    await settle();
    expect(host.calls).toEqual([]);
    expect(terminal.frame).not.toContain("Stop lumora?");
    terminal.keyListener("x");
    expect(terminal.frame).toContain("Stop lumora?");
    terminal.keyListener("y");
    await settle();
    expect(host.calls).toEqual(["stop a1"]);
    expect(terminal.frame).toContain("○ stopped since");
    expect(terminal.frame).toContain("○ lumora");
    terminal.keyListener("q");
    await done;
  });

  it("removes a stopped agent with x and restarts with r and R", async () => {
    const host = new FakeHost([stoppedOf(lumora), stoppedOf(radio), portfolio], { a1: [] }, new Date("2026-10-28T18:42:10").toISOString());
    const { terminal, done } = await start(host);
    expect(terminal.frame).toContain("The agents stopped (the Mac restarted or the session closed at 18:42).");
    terminal.keyListener("r");
    await settle();
    expect(host.calls).toEqual(["restart a1"]);
    expect(terminal.frame).toContain("The agents stopped");
    terminal.keyListener("R");
    await settle();
    expect(host.calls).toEqual(["restart a1", "restart-all"]);
    host.listener!({ event: "fresh-start" });
    await settle();
    expect(terminal.frame).not.toContain("The agents stopped");
    terminal.keyListener("q");
    await done;
  });

  it("removes the selected stopped agent from the list", async () => {
    const host = new FakeHost([lumora, portfolio], { a1: lumoraLog });
    const { terminal, done } = await start(host, "a4");
    terminal.keyListener("x");
    await settle();
    expect(host.calls).toEqual(["remove a4"]);
    expect(terminal.frame).toContain("1 agent ");
    expect(terminal.frame).not.toContain("portfolio");
    terminal.keyListener("q");
    await done;
  });

  it("applies a model and effort chosen in the dialog, and shows them in the list and detail", async () => {
    const host = new FakeHost([lumora, radio], { a1: lumoraLog });
    const { terminal, done } = await start(host);
    terminal.keyListener("m");
    expect(terminal.frame).toContain("A run is in progress (Lumora Pro / Tarifs): it finishes with Opus · medium.");
    terminal.keyListener("right");
    terminal.keyListener("down");
    terminal.keyListener("right");
    terminal.keyListener("enter");
    await settle();
    expect(host.calls).toEqual(["set a1 sonnet high"]);
    expect(terminal.frame).not.toContain("Model and effort");
    expect(terminal.frame).toContain("Model     Sonnet");
    expect(terminal.frame).toContain("Effort    high");
    expect(terminal.frame).toContain("Sonnet · high");
    terminal.keyListener("q");
    await done;
  });

  it("redraws on resize", async () => {
    const { terminal, done } = await start(new FakeHost([lumora], { a1: lumoraLog }));
    terminal.columns = 100;
    terminal.rows = 30;
    terminal.resizeListener();
    expect(terminal.frames.at(-1)).toHaveLength(30);
    terminal.keyListener("ctrl-c");
    await done;
  });

  it("restores the terminal when the host fails", async () => {
    const host = new FakeHost([], {});
    host.snapshot = async () => {
      throw new Error("The agent host closed the connection.");
    };
    const terminal = new FakeTerminal();
    await expect(runAgentsScreen({ host, terminal, now: () => NOW, home: "/", folder: FOLDER, newAgent: new FakeFlow(), openUrl: () => undefined, tickMs: 1_000_000 })).rejects.toThrow("closed the connection");
    expect(terminal.closed).toBe(true);
  });

  describe("n: a new agent for the screen's folder", () => {
    const type = (terminal: FakeTerminal, text: string) => [...text].forEach((char) => terminal.keyListener(char));
    const cv = agent({ id: "a9", name: "cv", folder: FOLDER, projectNames: ["CV Vincent"], state: "reconnecting" });

    it("offers the server's projects and the create option for a folder that is not linked yet, and starts the agent on the project created", async () => {
      const host = new FakeHost([lumora, radio], { a1: lumoraLog });
      const { terminal, done, flow } = await start(host);
      flow.agent = cv;
      terminal.keyListener("n");
      await settle();
      expect(terminal.frame).toContain("New agent  in the current folder");
      expect(terminal.frame).toContain("~/claude-projects/cv  isn't linked to a project yet.");
      expect(terminal.frame).toContain("› ● Lumora");
      expect(terminal.frame).toContain("○ Radio HAIDF");
      expect(terminal.frame).toContain("Create a new project:");
      expect(terminal.frame).toMatch(/Model {5} opus {3}sonnet {3}haiku/);
      expect(terminal.frame).toMatch(/Effort {4} default {3}low {3}medium {3}high {3}xhigh {3}max/);
      expect(terminal.frame).toContain("Last choice for this folder is preselected.");
      terminal.keyListener("down");
      terminal.keyListener("down");
      expect(terminal.frame).toContain("› ● Create a new project:");
      type(terminal, "CV Vincent");
      expect(terminal.frame).toContain("CV Vincent▏");
      terminal.keyListener("backspace");
      expect(terminal.frame).toContain("CV Vincen▏");
      terminal.keyListener("t");
      terminal.keyListener("right");
      terminal.keyListener("enter");
      await settle();
      expect(flow.started).toEqual([{ serverUrl: "https://redline.brightco.fr", project: { create: "CV Vincent" }, model: "sonnet", effort: "medium" }]);
      host.listener!({ event: "agent-added", agent: cv });
      await settle();
      expect(terminal.frame).not.toContain("New agent  in the current folder");
      expect(terminal.frame).toContain("› ● cv");
      expect(terminal.frame).toContain("3 agents");
      terminal.keyListener("q");
      await done;
    });

    it("links an existing project when one is picked, and takes the effort chosen", async () => {
      const { terminal, done, flow } = await start(new FakeHost([lumora], { a1: lumoraLog }));
      flow.agent = cv;
      terminal.keyListener("n");
      await settle();
      for (const key of ["down", "down", "down", "down", "right"]) terminal.keyListener(key);
      terminal.keyListener("enter");
      await settle();
      expect(flow.started).toEqual([{ serverUrl: "https://redline.brightco.fr", project: { existing: "p2" }, model: "opus", effort: "high" }]);
      terminal.keyListener("q");
      await done;
    });

    it("does not start with an empty project title", async () => {
      const { terminal, done, flow } = await start(new FakeHost([lumora], { a1: lumoraLog }));
      terminal.keyListener("n");
      await settle();
      terminal.keyListener("down");
      terminal.keyListener("down");
      terminal.keyListener("enter");
      await settle();
      expect(flow.started).toEqual([]);
      terminal.keyListener("escape");
      terminal.keyListener("q");
      await done;
    });

    it("skips the project question for a folder that is already linked", async () => {
      const { terminal, done, flow } = await start(new FakeHost([lumora], { a1: lumoraLog }));
      flow.questions = { servers: [], serverUrl: "https://redline.brightco.fr", linkedTitles: ["Lumora", "Lumora Pro"], model: "haiku", effort: undefined };
      flow.agent = cv;
      terminal.keyListener("n");
      await settle();
      expect(terminal.frame).toContain("~/claude-projects/cv  serves Lumora, Lumora Pro.");
      expect(terminal.frame).not.toContain("Create a new project");
      expect(terminal.frame).toMatch(/Model {5} opus {3}sonnet {3}haiku/);
      terminal.keyListener("enter");
      await settle();
      expect(flow.started).toEqual([{ serverUrl: "https://redline.brightco.fr", model: "haiku", effort: undefined }]);
      terminal.keyListener("q");
      await done;
    });

    it("asks the server first when several are set up, then its projects", async () => {
      const { terminal, done, flow } = await start(new FakeHost([lumora], { a1: lumoraLog }));
      flow.questions = { servers: ["https://a.example", "https://b.example"], model: "opus" };
      flow.projectsByServer["https://b.example"] = [{ id: "pb", title: "Bravo" }];
      flow.agent = cv;
      terminal.keyListener("n");
      await settle();
      expect(terminal.frame).toContain("Server");
      expect(terminal.frame).toContain("https://a.example");
      terminal.keyListener("down");
      terminal.keyListener("enter");
      await settle();
      expect(terminal.frame).toContain("› ● Bravo");
      terminal.keyListener("enter");
      await settle();
      expect(flow.started).toEqual([{ serverUrl: "https://b.example", project: { existing: "pb" }, model: "opus", effort: undefined }]);
      terminal.keyListener("q");
      await done;
    });

    it("selects the agent that already serves the folder instead of opening the dialog", async () => {
      const { terminal, done, flow } = await start(new FakeHost([lumora, cv], { a1: lumoraLog }));
      expect(terminal.frame).toContain("› ● lumora");
      terminal.keyListener("n");
      await settle();
      expect(terminal.frame).toContain("› ● cv");
      expect(terminal.frame).not.toContain("New agent  in the current folder");
      expect(flow.started).toEqual([]);
      terminal.keyListener("q");
      await done;
    });

    it("shows why an agent could not be started, and stays open", async () => {
      const { terminal, done, flow } = await start(new FakeHost([lumora], { a1: lumoraLog }));
      flow.failWith = "Claude Code is not logged in.";
      terminal.keyListener("n");
      await settle();
      terminal.keyListener("enter");
      await settle();
      expect(terminal.frame).toContain("✗ Claude Code is not logged in.");
      terminal.keyListener("escape");
      expect(terminal.frame).not.toContain("New agent  in the current folder");
      terminal.keyListener("q");
      await done;
    });

    it("offers n on an empty screen and in the bar", async () => {
      const { terminal, done } = await start(new FakeHost([], {}));
      expect(terminal.frame).toContain("No agent yet. Press n to start one in this folder.");
      expect(terminal.frame).toMatch(/ n +new agent here/);
      terminal.keyListener("q");
      await done;
    });
  });

  describe("o: open in Redline", () => {
    const running = { ...lumora, run: { page: "Tarifs", pageId: "pg-42" } };

    it("opens the canvas of the run in progress", async () => {
      const { terminal, done, opened } = await start(new FakeHost([running, radio], { a1: lumoraLog }));
      terminal.keyListener("o");
      expect(opened).toEqual(["https://redline.brightco.fr/#/pages/pg-42"]);
      terminal.keyListener("q");
      await done;
    });

    it("opens the server's Agents screen when the agent is idle", async () => {
      const { terminal, done, opened } = await start(new FakeHost([lumora, radio], { a1: lumoraLog }), "a2");
      terminal.keyListener("o");
      expect(opened).toEqual(["https://redline.brightco.fr/#/agents"]);
      terminal.keyListener("q");
      await done;
    });

    it("shows the keys in the bar, in the board's order, and none for a stopped agent", async () => {
      const { terminal, done } = await start(new FakeHost([lumora, portfolio], { a1: lumoraLog }));
      expect(terminal.frame).toMatch(/↑↓ +agent +n +new agent here +m +model\/effort +o +open in Redline +x +stop +q +close · agents keep running/);
      terminal.keyListener("down");
      expect(terminal.frame).toMatch(/↑↓ +agent +r +restart +R +restart all +n +new agent here +m +model\/effort +x +remove +q +close\s/);
      terminal.keyListener("q");
      await done;
    });
  });
});

describe("text from the server on the terminal", () => {
  const evil = "\x1b]0;pwned\x07\x1b[2J\x9b31mEvil\r\nnext\ttab";
  const clean = "]0;pwned[2J31mEvil  next tab";

  it("reaches the screen without any control character: only the screen's own colour codes remain", () => {
    const attacked = agent({ id: "a1", name: "lumora", state: "running", run: { page: evil, pageId: "p1" }, projectNames: [evil], reason: evil });
    const log = [
      entry("14:05:40", { type: "run-started", workId: "w1", project: evil, page: evil, kind: "comment", author: evil, excerpt: evil, attempt: 1 }),
      entry("14:05:41", { type: "run-progress", workId: "w1", steps: [evil], elapsedMs: 1000 }),
      entry("14:06:00", { type: "stopped", reason: "failed", error: evil }),
    ];
    const lines = render(open([attacked], "a1", { a1: log }), { columns: 184, rows: 43 });
    const withoutOwnCodes = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    for (const line of withoutOwnCodes) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(withoutOwnCodes.join("\n")).toContain(clean);
    for (const line of closeSummary(open([attacked], "a1", { a1: log }))) expect(line.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it("is cleaned in the project titles and the errors of the new agent dialog too", () => {
    let state = open([]);
    state = onKey(state, "n").state;
    state = newAgentQuestions(state, { servers: [], serverUrl: "https://redline.brightco.fr", projects: [{ id: "p1", title: evil }], model: "opus" });
    state = newAgentFailed(state, evil);
    const lines = render(state, { columns: 184, rows: 43 }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(lines.join("\n")).toContain(clean);
  });
});
