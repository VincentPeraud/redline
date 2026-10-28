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
  /** When the host started fresh after the previous one died with agents running; the banner shows while every agent is still stopped. */
  freshStartAt?: string;
  /** The dialog open over the screen, if any: it takes every key until it closes. */
  dialog?: { type: "stop"; agentId: string };
}

/** What a key asks of the driver; the keys of later tickets add commands here (launch, set model...). */
export type ScreenCommand =
  | { type: "close" }
  | { type: "stop"; agentId: string }
  | { type: "remove"; agentId: string }
  | { type: "restart"; agentId: string }
  | { type: "restart-all" };

export interface Update {
  state: ScreenState;
  commands: ScreenCommand[];
}

export interface Size {
  columns: number;
  rows: number;
}

export function initialState({ agents, selectedId, now, home, freshStartAt }: { agents: HostAgent[]; selectedId?: string; now: number; home: string; freshStartAt?: string }): ScreenState {
  const selected = agents.some((agent) => agent.id === selectedId) ? selectedId : agents[0]?.id;
  return { agents, selectedId: selected, logs: {}, loaded: {}, now, home, freshStartAt };
}

export const tick = (state: ScreenState, now: number): ScreenState => ({ ...state, now });

/** The run log read from the host replaces what was known, keeping the lines that arrived while it was loading. */
export function logLoaded(state: ScreenState, agentId: string, entries: HostLogEntry[]): ScreenState {
  const known = new Set(entries.map((entry) => JSON.stringify(entry)));
  const early = state.loaded[agentId] ? [] : (state.logs[agentId] ?? []).filter((entry) => !known.has(JSON.stringify(entry)));
  return { ...state, logs: { ...state.logs, [agentId]: [...entries, ...early] }, loaded: { ...state.loaded, [agentId]: true } };
}

export function applyEvent(state: ScreenState, event: HostEvent): ScreenState {
  const next = reduce(state, event);
  const started = (event.event === "agent-added" || event.event === "agent-changed") && event.agent.state !== "stopped";
  const asked = next.dialog && next.agents.find((agent) => agent.id === next.dialog?.agentId);
  return { ...next, freshStartAt: started ? undefined : next.freshStartAt, dialog: asked?.state === "running" ? next.dialog : undefined };
}

function reduce(state: ScreenState, event: HostEvent): ScreenState {
  switch (event.event) {
    case "agent-added":
      return state.agents.some((agent) => agent.id === event.agent.id)
        ? reduce(state, { event: "agent-changed", agent: event.agent })
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
  if (state.dialog) {
    if (key === "y") return { state: { ...state, dialog: undefined }, commands: [{ type: "stop", agentId: state.dialog.agentId }] };
    return { state: key === "escape" ? { ...state, dialog: undefined } : state, commands: [] };
  }
  const index = state.agents.findIndex((agent) => agent.id === state.selectedId);
  if (key === "up" || key === "down") {
    const next = state.agents[Math.min(state.agents.length - 1, Math.max(0, index + (key === "up" ? -1 : 1)))];
    return { state: next ? { ...state, selectedId: next.id } : state, commands: [] };
  }
  if (key === "q" || key === "ctrl-c") return { state, commands: [{ type: "close" }] };
  const selected = selectedAgent(state);
  if (key === "x" && selected) {
    if (selected.state === "running") return { state: { ...state, dialog: { type: "stop", agentId: selected.id } }, commands: [] };
    return { state, commands: [{ type: selected.state === "stopped" ? "remove" : "stop", agentId: selected.id }] };
  }
  if (key === "r" && selected?.state === "stopped") return { state, commands: [{ type: "restart", agentId: selected.id }] };
  if (key === "R" && state.agents.some((agent) => agent.state === "stopped")) return { state, commands: [{ type: "restart-all" }] };
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
        else {
          const why = { updated: "updating, restarting", stopped: "stopped on request", "host-restarted": "the Mac restarted or the session closed" }[event.reason];
          rows.push(line(at, span("○ Stopped", C.muted, true), span(`  ${why}`, C.dim)));
        }
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

/** The keys that apply to the selected agent. Later tickets add theirs (n, m, o) before `x`. */
export function actionBar(state: ScreenState): BarItem[] {
  const agent = selectedAgent(state);
  if (agent?.state === "stopped") {
    return [
      { key: "↑↓", label: "agent" },
      { key: "r", label: "restart" },
      { key: "R", label: "restart all" },
      { key: "x", label: "remove" },
      { key: "q", label: "close", muted: true },
    ];
  }
  return [{ key: "↑↓", label: "agent" }, ...(agent ? [{ key: "x", label: "stop" }] : []), { key: "q", label: "close · agents keep running", muted: true }];
}

function selectedAgent(state: ScreenState): HostAgent | undefined {
  return state.agents.find((agent) => agent.id === state.selectedId);
}

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

/** After a fresh start of the host, while every agent is still stopped: says why, and which keys bring them back. */
function bannerRows(state: ScreenState, cells: number): Row[] {
  if (!state.freshStartAt || state.agents.length === 0 || state.agents.some((agent) => agent.state !== "stopped")) return [];
  const inner = cells - 2 * MARGIN - 2;
  const edge = (text: string) => span(text, C.rule, false, C.bar);
  const line = (...content: Span[]): Row => ({ spans: [span(spaces(MARGIN)), edge("│"), ...fit([span(" ", C.text, false, C.bar), ...content.map((s) => ({ ...s, bg: C.bar }))], inner, C.bar), edge("│")] });
  const border = (left: string, right: string): Row => ({ spans: [span(spaces(MARGIN)), edge(`${left}${"─".repeat(inner)}${right}`)] });
  return [
    border("┌", "┐"),
    line(span("○ ", C.dim), span(`The agents stopped (the Mac restarted or the session closed at ${clock(state.freshStartAt, false)}).`, C.muted)),
    line(span("  "), span("r", C.text, true), span(" restarts the selected one with the same folder, model and effort · ", C.muted), span("R", C.text, true), span(" restarts all.", C.muted)),
    border("└", "┘"),
  ];
}

function leftColumn(state: ScreenState, cells: number, height: number): Row[] {
  const agent = selectedAgent(state);
  if (!agent) {
    return [{ spans: [] }, { spans: [span(`${spaces(MARGIN)}No agent yet. Run \`redline agent\` in a project folder to start one.`, C.muted)] }];
  }
  const log = state.logs[agent.id] ?? [];
  const head = [...detailRows(state, agent, log, cells), ruleRow(), ...bannerRows(state, cells), { spans: [span(`${spaces(MARGIN)}LOG`, C.muted, true)] }];
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

/** Inverse-video key caps, each followed by its label. */
function keyCaps(items: BarItem[]): Span[] {
  return items.flatMap((item) => [span(` ${item.key} `, C.bg, true, item.muted ? C.muted : C.text), span(" ", C.muted, false, C.bar), span(item.label, C.muted, false, C.bar), span("   ", C.muted, false, C.bar)]);
}

const barRow = (state: ScreenState, columns: number): Span[] => fit([span(spaces(MARGIN), C.text, false, C.bar), ...keyCaps(actionBar(state))], columns, C.bar);

// ---- Dialogs -------------------------------------------------------------------------------------------------

const DIALOG_WIDTH = 90;
/** The board dims the screen behind a dialog with 55 % black. */
const DIM = 0.45;
const dimmed = (hex: string) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * DIM).toString(16).padStart(2, "0")).join("")}`;
const dim = (spans: Span[]): Span[] => spans.map((s) => ({ ...s, fg: dimmed(s.fg ?? C.text), bg: dimmed(s.bg ?? C.bg) }));

/** The cells from `from` up to `to` of a line. */
function cut(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const s of spans) {
    const chars = [...s.text];
    const text = chars.slice(Math.max(0, from - at), Math.max(0, to - at)).join("");
    if (text) out.push({ ...s, text });
    at += chars.length;
  }
  return out;
}

const stopDialog = (state: ScreenState, agent: HostAgent, inner: number): Row[] => {
  const log = state.logs[agent.id] ?? [];
  const started = log.filter((entry) => entry.event.type === "run-started").at(-1);
  const run = started?.event as RunStarted | undefined;
  const place = run ? placeOf(run.project, run.page) : (agent.page ?? "");
  const elapsed = started ? ` (${duration(state.now - Date.parse(started.at))})` : "";
  const edge = (text: string, bg = C.bg) => span(text, C.muted, false, bg);
  const line = (bg: string, ...content: Span[]): Row => ({ spans: [edge("│", bg), ...fit([span(" ", C.text, false, bg), ...content.map((s) => ({ ...s, bg: s.bg ?? bg }))], inner, bg), edge("│", bg)] });
  const separator: Row = { spans: [edge("├"), span("─".repeat(inner), C.rule), edge("┤")] };
  return [
    { spans: [edge(`┌${"─".repeat(inner)}┐`)] },
    line(C.bg, span(`Stop ${agent.name}?`, C.text, true)),
    separator,
    line(C.bg, span("A run is in progress on ", C.muted), span(place), span(`${elapsed}.`, C.muted)),
    line(C.bg, span("Stopping cancels it; the conversation stays open in Redline.", C.muted)),
    line(C.bg),
    line(C.bg, span("The agent stays in the list as stopped: ", C.dim), span("r", C.text, true), span(" restarts it, ", C.dim), span("x", C.text, true), span(" again removes it.", C.dim)),
    separator,
    line(C.bar, ...keyCaps([{ key: "y", label: "stop" }, { key: "Esc", label: "keep running" }])),
    { spans: [edge(`└${"─".repeat(inner)}┘`)] },
  ];
};

/** The whole screen: exactly `rows` lines of `columns` cells, with ANSI colours (24-bit) and background. */
export function render(state: ScreenState, { columns, rows }: Size): string[] {
  const rightCells = Math.min(RIGHT_WIDTH, Math.floor(columns / 3));
  const leftCells = Math.max(1, columns - rightCells - 1);
  const bodyHeight = Math.max(0, rows - 4);
  const left = leftColumn(state, leftCells, bodyHeight);
  const right = rightColumn(state, rightCells, bodyHeight);
  const rule = (cells: number) => span("─".repeat(cells), C.rule);
  const out: Span[][] = [];

  out.push(fit(headerRow(state, columns).spans, columns));
  out.push([span("─".repeat(leftCells), C.rule), span("┬", C.rule), rule(rightCells)]);
  for (let i = 0; i < bodyHeight; i++) {
    const l = left[i] ?? { spans: [] };
    const r = right[i] ?? { spans: [] };
    const joint = l.rule && r.rule ? "┼" : l.rule ? "┤" : r.rule ? "├" : "│";
    const side = (row: Row, cells: number) => (row.rule ? [rule(cells)] : fit(row.spans, cells));
    out.push([...side(l, leftCells), span(joint, C.rule), ...side(r, rightCells)]);
  }
  out.push([span("─".repeat(leftCells), C.rule), span("┴", C.rule), rule(rightCells)]);
  out.push(barRow(state, columns));
  const frame = out.slice(0, rows);

  const asked = state.dialog && selectedAgent(state);
  if (!asked) return frame.map((line) => toAnsi(line));
  const boxWidth = Math.min(DIALOG_WIDTH, columns - 4);
  const box = stopDialog(state, asked, boxWidth - 2);
  const top = Math.max(1, Math.floor((rows - box.length) * 0.4));
  const boxLeft = Math.floor((columns - boxWidth) / 2);
  return frame.map((line, index) => {
    const row = box[index - top];
    const behind = dim(line);
    return toAnsi(row ? [...cut(behind, 0, boxLeft), ...fit(row.spans, boxWidth), ...cut(behind, boxLeft + boxWidth, columns)] : behind);
  });
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
