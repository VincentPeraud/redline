import { modelLabel } from "@redline/shared";
import type { HostAgent, HostEvent, HostLogEntry, HostLogEvent } from "./host-protocol.js";

/**
 * The agents screen as pure functions: state + key -> next state + commands, state + size -> frame lines.
 * Layout, colours and copy follow the `AgentsTui` and `AgentsTuiShell` boards of the Redline concept artifact.
 */

/** "up", "down", "ctrl-c", or the character typed. */
export type Key = string;

export interface ScreenState {
  agents: HostAgent[];
  selectedId?: string;
  /** Each agent's run log, oldest first. */
  logs: Record<string, HostLogEntry[]>;
  /** Agents whose log was loaded from the host; lines that arrive before are kept and merged on load. */
  loaded: Record<string, true>;
  /** Epoch ms: the clock of uptimes. */
  now: number;
  /** The user's home directory, abbreviated `~` in folders. */
  home: string;
}

/** What a key asks of the driver; the keys of later tickets add commands here (stop, launch, restart...). */
export type ScreenCommand = { type: "close" };

export interface Update {
  state: ScreenState;
  commands: ScreenCommand[];
}

export interface Size {
  columns: number;
  rows: number;
}

export function initialState({ agents, selectedId, now, home }: { agents: HostAgent[]; selectedId?: string; now: number; home: string }): ScreenState {
  const selected = agents.some((agent) => agent.id === selectedId) ? selectedId : agents[0]?.id;
  return { agents, selectedId: selected, logs: {}, loaded: {}, now, home };
}

export const tick = (state: ScreenState, now: number): ScreenState => ({ ...state, now });

/** The run log read from the host replaces what was known, keeping the lines that arrived while it was loading. */
export function logLoaded(state: ScreenState, agentId: string, entries: HostLogEntry[]): ScreenState {
  const known = new Set(entries.map((entry) => JSON.stringify(entry)));
  const early = state.loaded[agentId] ? [] : (state.logs[agentId] ?? []).filter((entry) => !known.has(JSON.stringify(entry)));
  return { ...state, logs: { ...state.logs, [agentId]: [...entries, ...early] }, loaded: { ...state.loaded, [agentId]: true } };
}

export function applyEvent(state: ScreenState, event: HostEvent): ScreenState {
  switch (event.event) {
    case "agent-added":
      return state.agents.some((agent) => agent.id === event.agent.id)
        ? applyEvent(state, { event: "agent-changed", agent: event.agent })
        : { ...state, agents: [...state.agents, event.agent], selectedId: state.selectedId ?? event.agent.id };
    case "agent-changed":
      return { ...state, agents: state.agents.map((agent) => (agent.id === event.agent.id ? event.agent : agent)) };
    case "agent-removed": {
      const agents = state.agents.filter((agent) => agent.id !== event.agentId);
      const selectedId = state.selectedId === event.agentId ? nextSelection(state.agents, event.agentId) : state.selectedId;
      const { [event.agentId]: _log, ...logs } = state.logs;
      const { [event.agentId]: _loaded, ...loaded } = state.loaded;
      return { ...state, agents, selectedId, logs, loaded };
    }
    case "log-line":
      return { ...state, logs: { ...state.logs, [event.agentId]: [...(state.logs[event.agentId] ?? []), event.entry] } };
  }
}

function nextSelection(agents: HostAgent[], removedId: string): string | undefined {
  const index = agents.findIndex((agent) => agent.id === removedId);
  return (agents[index + 1] ?? agents[index - 1])?.id;
}

export function onKey(state: ScreenState, key: Key): Update {
  const index = state.agents.findIndex((agent) => agent.id === state.selectedId);
  if (key === "up" || key === "down") {
    const next = state.agents[Math.min(state.agents.length - 1, Math.max(0, index + (key === "up" ? -1 : 1)))];
    return { state: next ? { ...state, selectedId: next.id } : state, commands: [] };
  }
  if (key === "q" || key === "ctrl-c") return { state, commands: [{ type: "close" }] };
  return { state, commands: [] };
}

// ---- Cells ---------------------------------------------------------------------------------------------------

const C = {
  bg: "#18181B",
  bar: "#111113",
  selected: "#27272A",
  text: "#E4E4E7",
  muted: "#A1A1AA",
  dim: "#71717A",
  rule: "#3F3F46",
  amber: "#FBBF24",
  green: "#4ADE80",
  red: "#D92D20",
};

interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}
interface Row {
  spans: Span[];
  /** A horizontal rule: it joins the vertical border with a tee. */
  rule?: boolean;
}

const span = (text: string, fg: string = C.text, bold = false, bg?: string): Span => ({ text, fg, bold, bg });
const width = (spans: Span[]) => spans.reduce((total, s) => total + [...s.text].length, 0);
const spaces = (count: number) => " ".repeat(Math.max(0, count));

/** Cuts the spans to `limit` cells, ending with an ellipsis when something was cut. */
function clip(spans: Span[], limit: number): Span[] {
  if (width(spans) <= limit) return spans;
  const out: Span[] = [];
  let left = Math.max(0, limit - 1);
  for (const s of spans) {
    const chars = [...s.text];
    if (chars.length <= left) {
      out.push(s);
      left -= chars.length;
    } else {
      out.push({ ...s, text: chars.slice(0, left).join("") });
      break;
    }
  }
  const last = out.at(-1);
  return [...out, { text: "…", fg: last?.fg, bg: last?.bg }];
}

function fit(spans: Span[], cells: number, bg?: string): Span[] {
  const clipped = clip(spans, cells);
  return [...clipped, { text: spaces(cells - width(clipped)), bg }];
}

const hexToSgr = (hex: string, layer: 38 | 48) => `${layer};2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;

/** `paint` draws the board's background; the shell summary leaves the terminal's own. */
function toAnsi(spans: Span[], paint = true): string {
  return (
    spans
      .filter((s) => s.text)
      .map((s) => `\x1b[0;${[...(paint ? [hexToSgr(s.bg ?? C.bg, 48)] : []), hexToSgr(s.fg ?? C.text, 38), ...(s.bold ? ["1"] : [])].join(";")}m${s.text}`)
      .join("") + "\x1b[0m"
  );
}

/** The visible text of ANSI lines, for tests and captures. */
export const plainText = (lines: string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

const ruleRow = (): Row => ({ spans: [], rule: true });

// ---- Formatting ----------------------------------------------------------------------------------------------

const clock = (iso: string, seconds = true) => {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
};

function duration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${total % 60} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function uptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const folderLabel = (folder: string, home: string) => (home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder);

type RunStarted = Extract<HostLogEvent, { type: "run-started" }>;
const lastStarted = (log: HostLogEntry[]): RunStarted | undefined => log.map((e) => e.event).filter((e): e is RunStarted => e.type === "run-started").at(-1);
const placeOf = (project: string | undefined, page: string) => (project ? `${project} / ${page}` : page);

/** What an agent is doing, in one phrase: `running · Lumora Pro / Tarifs`. */
function activityLabel(agent: HostAgent, log: HostLogEntry[]): string {
  if (agent.state !== "running") return agent.state;
  const started = lastStarted(log);
  const page = agent.page ?? started?.page;
  if (!page) return "running";
  return `running · ${placeOf(started?.page === page ? started.project : undefined, page)}`;
}

const STATE_COLOR: Record<HostAgent["state"], string> = { running: C.amber, idle: C.green, reconnecting: C.amber, stopped: C.dim };
const dot = (agent: HostAgent) => (agent.state === "stopped" ? "○" : "●");

// ---- Run log -------------------------------------------------------------------------------------------------

const TIME_WIDTH = 10;

function logRows(log: HostLogEntry[]): Row[] {
  // A run's progress shows under its start line only while the run is in progress: a later end of the run, or of the worker, drops it.
  const progress = new Map<string, Extract<HostLogEvent, { type: "run-progress" }>>();
  const lastStart = new Map<string, number>();
  const projects = new Map<string, string>();
  log.forEach(({ event }, index) => {
    switch (event.type) {
      case "run-started":
        lastStart.set(event.workId, index);
        progress.delete(event.workId);
        if (event.project) projects.set(event.workId, event.project);
        break;
      case "run-progress":
        progress.set(event.workId, event);
        break;
      case "run-published":
      case "run-failed":
        progress.delete(event.workId);
        lastStart.delete(event.workId);
        break;
      case "connected":
      case "refused":
      case "stopped":
        progress.clear();
        break;
    }
  });

  const rows: Row[] = [];
  const indent = spaces(TIME_WIDTH);
  const line = (at: string, ...rest: Span[]): Row => ({ spans: [span(`${clock(at)}  `, C.dim), ...rest] });
  const detail = (text: string): Row => ({ spans: [span(`${indent}  ${text}`, C.dim)] });
  const title = (glyph: string, color: string, label: string) => [span(`${glyph} `, color), span(`${label}  `, C.text, true)];

  log.forEach(({ at, event }, index) => {
    switch (event.type) {
      case "connected":
        rows.push(line(at, span(`Connected to ${event.serverUrl} as ${event.kind} agent.`, C.muted)));
        break;
      case "connection-lost":
        rows.push(line(at, span(event.reason ? `${event.reason} Retrying...` : "Connection lost, retrying...", C.muted)));
        break;
      case "reconnected":
        rows.push(line(at, span("Connected again.", C.muted)));
        break;
      case "refused":
        rows.push(line(at, ...title("✗", C.red, "Refused"), span(event.reason, C.muted)));
        break;
      case "run-started": {
        const who = event.author ? ` ${event.kind === "conversation" ? "with" : "by"} ${event.author}` : "";
        const attempt = event.attempt > 1 ? ` · attempt ${event.attempt}` : "";
        rows.push(line(at, ...title("▸", C.amber, "Run started"), span(placeOf(event.project, event.page)), span(`  ${event.kind}${who}${attempt}`, C.muted)));
        if (event.excerpt) rows.push(detail(`« ${event.excerpt} »`));
        const latest = progress.get(event.workId);
        if (latest && lastStart.get(event.workId) === index) rows.push(detail([...latest.steps.slice(-2), duration(latest.elapsedMs)].join(" · ")));
        break;
      }
      case "run-progress":
        break;
      case "run-published": {
        const place = placeOf(projects.get(event.workId), event.page);
        const outcome = event.changed.length > 0 ? `${plural(event.changed.length, "file")} changed` : "nothing changed";
        rows.push(line(at, ...title("✓", C.green, event.changed.length > 0 ? "Published" : "Finished"), span(place), span(`  ${outcome} · ${duration(event.durationMs)}`, C.muted)));
        break;
      }
      case "run-failed":
        rows.push(line(at, ...title("✗", C.red, "Run failed"), span(placeOf(projects.get(event.workId), event.page)), span(`  ${event.reason}`, C.muted)));
        break;
      case "stopped":
        if (event.reason === "failed") rows.push(line(at, ...title("✗", C.red, "Stopped"), span(event.error, C.muted)));
        else rows.push(line(at, ...title("○", C.dim, "Stopped"), span(event.reason === "updated" ? "updating, restarting" : "stopped on request", C.muted)));
        break;
    }
  });
  return rows;
}

// ---- Screen --------------------------------------------------------------------------------------------------

const MARGIN = 2;
const RIGHT_WIDTH = 46;
const LABEL_WIDTH = 10;

export interface BarItem {
  key: string;
  label: string;
  /** The closing key is drawn with a greyer cap. */
  muted?: boolean;
}

/** The keys that apply now. Later tickets add theirs (n, m, o, x, r, R) before `q`, according to the selected agent. */
export function actionBar(_state: ScreenState): BarItem[] {
  return [
    { key: "↑↓", label: "agent" },
    { key: "q", label: "close · agents keep running", muted: true },
  ];
}

const selectedAgent = (state: ScreenState) => state.agents.find((agent) => agent.id === state.selectedId);

function headerRow(state: ScreenState, columns: number): Row {
  const agent = selectedAgent(state);
  const runs = state.agents.filter((a) => a.state === "running").length;
  const allStopped = state.agents.length > 0 && state.agents.every((a) => a.state === "stopped");
  const left = [span("redline", C.text, true), span(" agents", C.muted), ...(agent ? [span(`  ${agent.serverUrl}`, C.dim)] : [])];
  const right = [
    span(plural(state.agents.length, "agent"), C.muted),
    span(" · ", C.dim),
    allStopped ? span("all stopped", C.dim) : runs > 0 ? span(`${plural(runs, "run")} in progress`, C.amber) : span("no run in progress", C.dim),
  ];
  const gap = columns - 2 * MARGIN - width(left) - width(right);
  return { spans: [span(spaces(MARGIN)), ...left, span(spaces(gap)), ...right] };
}

function detailRows(state: ScreenState, agent: HostAgent, log: HostLogEntry[], cells: number): Row[] {
  const status =
    agent.state === "stopped"
      ? [span(`○ stopped since ${clock(agent.since, false)}`, C.dim)]
      : agent.state === "running"
        ? [span(`● ${activityLabel(agent, log)}`, C.amber)]
        : [span(`● ${agent.state} since ${clock(agent.since, false)}`, STATE_COLOR[agent.state])];
  const left = [span(agent.name, C.text, true), span("  "), span(folderLabel(agent.folder, state.home), C.muted)];
  const gap = cells - 2 * MARGIN - width(left) - width(status);
  const field = (label: string, value: string, color: string = C.text): Row => ({ spans: [span(spaces(MARGIN)), span(label.padEnd(LABEL_WIDTH), C.dim), span(value, color)] });
  const projects = agent.kind === "global" ? "All projects" : (agent.projectNames?.join(", ") ?? "-");
  const machine = [agent.machine ?? "-", ...(agent.state !== "stopped" && agent.startedAt ? [`up ${uptime(state.now - Date.parse(agent.startedAt))}`] : [])].join(" · ");
  return [
    { spans: [] },
    { spans: [span(spaces(MARGIN)), ...left, span(spaces(gap)), ...status] },
    field("Projects", projects),
    field("Model", agent.model ? modelLabel(agent.model) : "Claude's default"),
    field("Effort", agent.effort ?? "Claude's default"),
    field("Account", agent.account ?? "unknown"),
    field("Machine", machine, C.muted),
  ];
}

function leftColumn(state: ScreenState, cells: number, height: number): Row[] {
  const agent = selectedAgent(state);
  if (!agent) {
    return [{ spans: [] }, { spans: [span(`${spaces(MARGIN)}No agent yet. Run \`redline agent\` in a project folder to start one.`, C.muted)] }];
  }
  const log = state.logs[agent.id] ?? [];
  const head = [...detailRows(state, agent, log, cells), ruleRow(), { spans: [span(`${spaces(MARGIN)}LOG`, C.muted, true)] }];
  const lines = logRows(log).map((row) => ({ spans: [span(spaces(MARGIN)), ...row.spans] }));
  return [...head, ...lines.slice(-Math.max(0, height - head.length))];
}

const ITEM_ROWS = 3;

function rightColumn(state: ScreenState, cells: number, height: number): Row[] {
  const rows: Row[] = [
    { spans: [span(spaces(MARGIN)), span("AGENTS", C.muted, true), span(` · ${state.agents.length}`, C.dim)] },
    ruleRow(),
    { spans: [] },
  ];
  const visible = Math.max(1, Math.floor((height - rows.length) / ITEM_ROWS));
  const selected = Math.max(0, state.agents.findIndex((agent) => agent.id === state.selectedId));
  const firstShown = Math.max(0, Math.min(selected - visible + 1, state.agents.length - visible));
  const nameWidth = Math.max(14, ...state.agents.map((agent) => [...agent.name].length));
  for (const agent of state.agents.slice(firstShown, firstShown + visible)) {
    const isSelected = agent.id === state.selectedId;
    const bg = isSelected ? C.selected : undefined;
    const stopped = agent.state === "stopped";
    const name = clip([span(agent.name)], nameWidth).map((s) => s.text).join("").padEnd(nameWidth);
    const model = agent.model ? modelLabel(agent.model) : "Claude's default";
    const nameLine = [
      span(isSelected ? "▎" : " ", C.red, false, bg),
      span(" ", C.text, false, bg),
      isSelected ? span("› ", C.red, true, bg) : span("  ", C.text, false, bg),
      span(`${dot(agent)} `, STATE_COLOR[agent.state], false, bg),
      span(name, stopped ? C.dim : C.text, isSelected, bg),
      span(agent.state.padStart(10), STATE_COLOR[agent.state], false, bg),
    ];
    const second = [span("    ", C.text, false, bg), span(`${model} · ${agent.effort ?? "Claude's default"}`, C.dim, false, bg)];
    rows.push({ spans: fit(nameLine, cells, bg) });
    rows.push({ spans: fit([span(isSelected ? "▎" : " ", C.red, false, bg), span(" ", C.text, false, bg), ...second], cells, bg) });
    rows.push({ spans: [] });
  }
  return rows;
}

function barRow(state: ScreenState, columns: number): Span[] {
  const spans: Span[] = [span(spaces(MARGIN), C.text, false, C.bar)];
  for (const item of actionBar(state)) {
    spans.push(span(` ${item.key} `, C.bg, true, item.muted ? C.muted : C.text), span(" ", C.muted, false, C.bar), span(item.label, C.muted, false, C.bar), span("   ", C.muted, false, C.bar));
  }
  return fit(spans, columns, C.bar);
}

/** The whole screen: exactly `rows` lines of `columns` cells, with ANSI colours (24-bit) and background. */
export function render(state: ScreenState, { columns, rows }: Size): string[] {
  const rightCells = Math.min(RIGHT_WIDTH, Math.floor(columns / 3));
  const leftCells = Math.max(1, columns - rightCells - 1);
  const bodyHeight = Math.max(0, rows - 4);
  const left = leftColumn(state, leftCells, bodyHeight);
  const right = rightColumn(state, rightCells, bodyHeight);
  const rule = (cells: number) => span("─".repeat(cells), C.rule);
  const out: string[] = [];

  out.push(toAnsi(fit(headerRow(state, columns).spans, columns)));
  out.push(toAnsi([span("─".repeat(leftCells), C.rule), span("┬", C.rule), rule(rightCells)]));
  for (let i = 0; i < bodyHeight; i++) {
    const l = left[i] ?? { spans: [] };
    const r = right[i] ?? { spans: [] };
    const joint = l.rule && r.rule ? "┼" : l.rule ? "┤" : r.rule ? "├" : "│";
    const side = (row: Row, cells: number) => (row.rule ? [rule(cells)] : fit(row.spans, cells));
    out.push(toAnsi([...side(l, leftCells), span(joint, C.rule), ...side(r, rightCells)]));
  }
  out.push(toAnsi([span("─".repeat(leftCells), C.rule), span("┴", C.rule), rule(rightCells)]));
  out.push(toAnsi(barRow(state, columns)));
  return out.slice(0, rows);
}

/** Printed in the shell after the screen closes (board `AgentsTuiShell`). */
export function closeSummary(state: ScreenState): string[] {
  const running = state.agents.filter((agent) => agent.state !== "stopped").length;
  const nameWidth = Math.max(0, ...state.agents.map((agent) => [...agent.name].length)) + 2;
  const heading = running > 0 ? `Screen closed. ${running === 1 ? "1 agent keeps" : `${running} agents keep`} running in the background:` : "Screen closed. No agent is running:";
  const lines = [toAnsi([span(heading)], false)];
  for (const agent of state.agents) {
    const stopped = agent.state === "stopped";
    lines.push(toAnsi([span("  "), span(`${dot(agent)} `, STATE_COLOR[agent.state]), span(agent.name.padEnd(nameWidth), stopped ? C.dim : C.text), span(activityLabel(agent, state.logs[agent.id] ?? []), stopped ? C.dim : C.muted)], false));
  }
  lines.push(toAnsi([span("Run ", C.muted), span("redline agents", C.text, true), span(" to see them again.", C.muted)], false));
  return lines;
}
