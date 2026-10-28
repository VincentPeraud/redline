import { describe, expect, it } from "vitest";
import { applyEvent, closeSummary, initialState, logLoaded, onKey, plainText, render, tick, type ScreenState } from "../src/agents-view.js";
import { runAgentsScreen, type ScreenHost, type ScreenTerminal } from "../src/agents-screen.js";
import type { HostAgent, HostEvent, HostLogEntry, HostLogEvent } from "../src/host-protocol.js";

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

const lumora = agent({ id: "a1", name: "lumora", state: "running", page: "Tarifs" });
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
  let state = initialState({ agents, selectedId, now: NOW, home: "/Users/vincent", freshStartAt });
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
    expect(frame).toContain("Edit Tarifs.dc.html · Read DESIGN.md · 28 s");
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
    expect(frame).toContain("No agent yet. Run `redline agent` in a project folder to start one.");
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
  const stoppedAgent = (a: HostAgent): HostAgent => ({ ...a, state: "stopped", page: undefined, since: new Date("2026-10-28T18:42:10").toISOString() });
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
    const done = applyEvent(asked, { event: "agent-changed", agent: { ...lumora, state: "idle", page: undefined } });
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
    expect(frame).toMatch(/↑↓ +agent +r +restart +R +restart all +x +remove +q +close\s/);
    expect(frame).not.toContain("close · agents keep running");
    expect(text(open([lumora, radio, portfolio], "a1"))).toMatch(/↑↓ +agent +x +stop +q +close · agents keep running/);
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
    expect(text(state)).not.toContain("The agents stopped");
    state = applyEvent(state, { event: "agent-changed", agent: stoppedAgent(lumora) });
    expect(text(state)).not.toContain("The agents stopped");
  });

  it("shows no banner without a fresh start, or while an agent is not stopped", () => {
    expect(text(allStopped())).not.toContain("The agents stopped");
    expect(text(open([lumora, portfolio], "a4", {}, new Date().toISOString()))).not.toContain("The agents stopped");
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
  async stop(agentId: string) { this.calls.push(`stop ${agentId}`); this.change(agentId, { state: "stopped", page: undefined }); return this.agents.find((a) => a.id === agentId)!; }
  async remove(agentId: string) { this.calls.push(`remove ${agentId}`); this.listener!({ event: "agent-removed", agentId }); }
  async restart(agentId: string) { this.calls.push(`restart ${agentId}`); this.change(agentId, { state: "reconnecting" }); return { agent: this.agents.find((a) => a.id === agentId)!, started: true }; }
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
const stoppedOf = (a: HostAgent): HostAgent => ({ ...a, state: "stopped", page: undefined });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the agents screen over a host client", () => {
  const start = async (host: FakeHost, selectedId?: string) => {
    const terminal = new FakeTerminal();
    const done = runAgentsScreen({ host, terminal, selectedId, now: () => NOW, home: "/Users/vincent", tickMs: 1_000_000 });
    await settle();
    return { terminal, done };
  };

  it("opens on the requested agent with its log, follows live lines, and resolves with the final state on q", async () => {
    const host = new FakeHost([lumora, radio], { a1: lumoraLog });
    const { terminal, done } = await start(host, "a2");
    expect(terminal.frame).toContain("› ● radio-haidf");
    terminal.keyListener("up");
    expect(terminal.frame).toContain("Edit Tarifs.dc.html · Read DESIGN.md · 28 s");
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
    expect(terminal.frame).not.toContain("The agents stopped");
    terminal.keyListener("R");
    await settle();
    expect(host.calls).toEqual(["restart a1", "restart-all"]);
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
    await expect(runAgentsScreen({ host, terminal, now: () => NOW, home: "/", tickMs: 1_000_000 })).rejects.toThrow("closed the connection");
    expect(terminal.closed).toBe(true);
  });
});
