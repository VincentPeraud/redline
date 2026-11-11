import { describe, expect, it } from "vitest";
import { initialState, logLoaded, newAgentQuestions, onKey, plainText, render, type ScreenState } from "../src/agents-view.js";
import { helpLines } from "../src/commands-help.js";
import type { InstanceEntry } from "../src/instance-list.js";
import type { HostAgent, HostLogEntry } from "../src/host-protocol.js";
import { MIGRATE_STOP_REASON } from "../src/activity.js";

const NOW = Date.parse("2026-11-11T12:00:00");
const FOLDER = "/Users/vincent/claude-projects/agora";
const HOME = "/Users/vincent";

const lumora: InstanceEntry = { id: "lumora", name: "Lumora", serverUrl: "https://redline.lumora.com", version: "0.2.0", tooOld: false };
const local: InstanceEntry = { id: "local", name: "Local", serverUrl: "https://redline.localhost", version: "0.3.0", tooOld: false };
const brightco: InstanceEntry = { id: "brightco", name: "Brightco", serverUrl: "https://redline.brightco.fr", version: "0.1.0", tooOld: true };
const instances = [lumora, local, brightco];

const agent = (name: string, over: Partial<HostAgent> = {}): HostAgent => ({
  id: name,
  name,
  folder: `/Users/vincent/${name}`,
  kind: "project",
  serverUrl: lumora.serverUrl,
  installation: "lumora",
  claudeConfigDir: "/x",
  account: "vincent@lumora.com",
  projectNames: ["Lumora · Site public"],
  model: "sonnet",
  effort: "medium",
  machine: "Mac-de-Vincent",
  state: "idle",
  since: new Date("2026-11-11T10:02:11").toISOString(),
  startedAt: new Date(NOW - 134 * 60_000).toISOString(),
  ...over,
});

const open = (agents: HostAgent[], over: Partial<Parameters<typeof initialState>[0]> = {}, logs: Record<string, HostLogEntry[]> = {}): ScreenState => {
  let state = initialState({ agents, now: NOW, home: HOME, folder: FOLDER, instances, folderLine: { kind: "linked", instance: "Lumora", project: "Agora" }, ...over });
  for (const [id, entries] of Object.entries(logs)) state = logLoaded(state, id, entries);
  return state;
};
const lines = (state: ScreenState, columns = 120, rows = 40) => plainText(render(state, { columns, rows }));
const text = (state: ScreenState, columns?: number, rows?: number) => lines(state, columns, rows).join("\n");
const press = (state: ScreenState, ...keys: string[]) => keys.reduce((s, k) => onKey(s, k).state, state);
const at = (time: string) => new Date(`2026-11-11T${time}`).toISOString();

const running = agent("lumora-site", { state: "running", run: { page: "Accueil", pageId: "p1" } });
const four = [agent("redline", { installation: "local", serverUrl: local.serverUrl, model: "opus", effort: "high" }), agent("agora", { model: "opus" }), running, agent("brightco-blog", { installation: "brightco", serverUrl: brightco.serverUrl, state: "stopped", model: undefined, effort: undefined })];

describe("the home screen", () => {
  it("shows the folder line and the tabs with their counts and problems", () => {
    const state = open(four, { selectedId: "lumora-site", instances: [{ ...lumora, problems: 3 }, local, brightco] });
    const frame = lines(state);
    expect(frame[1]).toMatch(/^ {2}redline {2}Lumora · redline\.lumora\.com +4 agents · 1 run in progress {2}$/);
    expect(frame[2]).toBe("  This folder ~/claude-projects/agora → Agora on Lumora".padEnd(120));
    expect(frame[4]).toMatch(/^ {2} Agents  4 {4} Instances  3 ! 3 {4} Comments  0 {5}Tab switches/);
  });

  it("says when the folder is not linked, and offers l", () => {
    const state = open(four, { folder: "/Users/vincent/Downloads", folderLine: { kind: "unlinked" } });
    expect(text(state)).toContain("This folder ~/Downloads  not linked to an instance · l links it");
  });

  it("switches tabs with Tab and 1 2 3, and keeps the bar's common keys", () => {
    const state = open(four);
    expect(press(state, "\t").tab).toBe("instances");
    expect(press(state, "\t", "\t").tab).toBe("comments");
    expect(press(state, "\t", "\t", "\t").tab).toBe("agents");
    expect(press(state, "3").tab).toBe("comments");
    expect(press(state, "3", "1").tab).toBe("agents");
    expect(press(state, "2").tab).toBe("instances");
    const placeholder = text(press(state, "3"));
    expect(placeholder).toContain("The Comments view is not available yet.");
    expect(placeholder).toMatch(/Tab +next tab/);
  });

  it("shows each agent's instance before its model and effort, and an Instance field in the detail", () => {
    const frame = text(open(four, { selectedId: "lumora-site" }));
    expect(frame).toContain("Instance   Lumora · redline.lumora.com · v0.2.0");
    expect(frame).toContain("Local · Opus · high");
    expect(frame).toContain("Lumora · Sonnet · medium");
    expect(frame).toContain("Brightco · Claude's default");
  });

  it("moves the focus with ← →, ↑↓ then scrolling the log instead of the list", () => {
    const log = Array.from({ length: 60 }, (_, i) => ({ at: at("10:00:00"), event: { type: "reconnected" as const } }) satisfies HostLogEntry).map((e, i) => ({ ...e, at: at(`10:${String(i).padStart(2, "0")}:00`) }));
    const state = open(four, { selectedId: "lumora-site" }, { "lumora-site": log });
    expect(state.focus).toBe("list");
    expect(text(state)).toContain("LOG  ← to scroll it");
    const left = press(state, "left");
    expect(left.focus).toBe("detail");
    expect(text(left)).toContain("▎ LOG");
    const scrolled = press(left, "up", "up", "up");
    expect(scrolled.selectedId).toBe("lumora-site");
    expect(text(scrolled)).not.toContain("10:59:00");
    expect(text(press(scrolled, "down", "down", "down"))).toContain("10:59:00");
    const back = press(left, "right");
    expect(back.focus).toBe("list");
    expect(press(back, "up").selectedId).toBe("agora");
  });

  it("shows how many agents are above and below the list, and keeps the selection in view", () => {
    const many = Array.from({ length: 12 }, (_, i) => agent(`agent-${String(i + 1).padStart(2, "0")}`));
    const top = text(open(many));
    expect(top).not.toMatch(/│ {2}↑/);
    expect(top).toMatch(/│ {2}↓ \d+ more/);
    const middle = text(open(many, { selectedId: "agent-04" }));
    expect(middle).toMatch(/│ {2}↑ 2 more/);
    expect(middle).toContain("› ● agent-04");
    const bottom = text(open(many, { selectedId: "agent-12" }));
    expect(bottom).not.toMatch(/│ {2}↓/);
    expect(bottom).toContain("› ● agent-12");
  });

  it("l offers to link an unlinked folder: straight to the only instance, else a choice", () => {
    const unlinked = { folderLine: { kind: "unlinked" as const } };
    expect(onKey(open(four, { ...unlinked, instances: [local] }), "l").commands).toEqual([{ type: "link-folder", serverUrl: local.serverUrl }]);
    const choosing = onKey(open(four, unlinked), "l").state;
    expect(text(choosing)).toContain("Link this folder");
    const done = onKey(press(choosing, "down"), "enter");
    expect(done.commands).toEqual([{ type: "link-folder", serverUrl: local.serverUrl }]);
    expect(done.state.dialog).toBeUndefined();
    expect(onKey(open(four), "l").commands).toEqual([]);
  });

  it("? shows the keys and the commands over the screen, Esc closes it", () => {
    const state = onKey(open(four), "?").state;
    const frame = text(state);
    expect(frame).toContain("Commands");
    expect(frame).toContain("redline agent --global --instance <i> start the global agent of an instance");
    expect(frame).toContain("redline help                        this list, in the shell");
    expect(press(state, "escape").dialog).toBeUndefined();
    expect(press(state, "?").dialog).toBeUndefined();
  });

  it("names redline migrate as the reason an agent stopped, in place of the restart banner", () => {
    const stopped = agent("old", { state: "stopped", reason: MIGRATE_STOP_REASON });
    const frame = text(open([stopped], { freshStartAt: new Date("2026-11-11T11:00:00").toISOString() }));
    expect(frame).toContain("Stopped by redline migrate.");
    expect(frame).not.toContain("the Mac restarted");
    expect(frame).toContain("restarts the selected one");
  });

  it("wraps a long refusal under its first line", () => {
    const refused = agent("brightco-blog", { state: "stopped", installation: "brightco", serverUrl: brightco.serverUrl });
    const reason = "the Brightco installation (v0.1.0) is too old for this redline command (v0.3.0, which accepts v0.2.0 and later). Brightco's server runs v0.1.0: it must be upgraded, then updated (Instances tab).";
    const frame = lines(open([refused], {}, { "brightco-blog": [{ at: at("10:44:02"), event: { type: "refused", reason } }] }), 120, 40);
    const first = frame.findIndex((line) => line.includes("✗ Refused"));
    expect(first).toBeGreaterThan(0);
    const left = frame.slice(first, first + 5).map((line) => line.slice(0, 73).trimEnd());
    expect(left.join(" ").replace(/\s+/g, " ")).toContain("(Instances tab).");
    expect(left[1]).toMatch(/^ {28}\S/);
    expect(frame[first + 1]).not.toContain("…");
  });

  it("n picks the instance first, a too old one dimmed and refused", () => {
    const base = open(four, { folder: "/Users/vincent/claude-projects/blog", folderLine: { kind: "unlinked" } });
    let state = onKey(base, "n").state;
    state = newAgentQuestions(state, { instances, model: "opus" });
    const frame = text(state);
    expect(frame).toContain("isn't linked to an instance yet.");
    expect(frame).toContain("› ● Lumora   redline.lumora.com    v0.2.0");
    expect(frame).toContain("  ○ Local    redline.localhost     v0.3.0");
    expect(frame).toContain("  ○ Brightco redline.brightco.fr   v0.1.0 · too old for this command");
    const chosen = onKey(press(state, "down", "down"), "enter");
    expect(chosen.commands).toEqual([]);
    expect(text(chosen.state)).toContain("Brightco is too old for this command");
    expect(onKey(state, "enter").commands).toEqual([{ type: "list-projects", serverUrl: lumora.serverUrl }]);
  });

  it("prints the commands for `redline help`", () => {
    const help = helpLines();
    expect(help).toContain("  redline                             this screen (alias: redline agents)");
    expect(help).toContain("  redline help                        this list, in the shell");
    expect(help.some((line) => line.includes("redline migrate"))).toBe(true);
  });
});
