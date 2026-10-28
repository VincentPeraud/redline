import { EFFORTS, MODEL_CHOICES, agentsHash, modelLabel, pageHash, type Effort } from "@redline/shared";
import { publishedOutcome, wording } from "./activity.js";
import { sanitizeForTerminal } from "./sanitize.js";
import type { HostAgent, HostEvent, HostLogEntry, HostLogEvent } from "./host-protocol.js";
import type { NewAgentAnswers, NewAgentQuestions, ProjectOption } from "./new-agent.js";

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
  /** The folder the screen was opened from: `n` starts or selects its agent. */
  folder: string;
  /** When the host started fresh after the previous one died with agents running; the banner shows while some agent is still stopped (the host says when the last one is back). */
  freshStartAt?: string;
  /** The dialog open over the screen, if any: it takes every key until it closes. */
  dialog?: Dialog;
}

/** A dialog open over the screen. Each type has its keys (`onDialogKey`), its box (`dialogBox`) and the condition that keeps it open (`dialogStillValid`). */
export type Dialog =
  | { type: "stop"; agentId: string }
  /** The choices being edited; they reach the host only on Enter. */
  | { type: "model"; agentId: string; field: "model" | "effort"; model: string; effort?: Effort }
  | NewAgentDialog;

/**
 * `n`: the questions of a new agent. It opens `loading` while the folder is inspected, goes through `server` when several are set up
 * and the folder is not linked, then `form`. The rows of the form are the projects, the create option, the model and the effort.
 */
export interface NewAgentDialog {
  type: "new";
  stage: "loading" | "server" | "form";
  servers: string[];
  serverRow: number;
  serverUrl?: string;
  /** The titles of the projects of a linked folder: there is no project question then. */
  linkedTitles?: string[];
  projects: ProjectOption[];
  /** The focused row: a project (or the create option, after the last one), then the model, then the effort. */
  row: number;
  /** The project picked: it follows the focus over the project rows and stays when the focus leaves them. */
  picked: number;
  /** The last existing project the focus was on: it is picked again when the focus leaves an empty create option. */
  kept: number;
  title: string;
  model: string;
  effort?: Effort;
  /** Set once Enter was pressed: the agent is being started. */
  busy?: boolean;
  error?: string;
}

/** What a key asks of the driver; the keys of later tickets add commands here (launch, set model...). */
export type ScreenCommand =
  | { type: "close" }
  | { type: "stop"; agentId: string }
  | { type: "remove"; agentId: string }
  | { type: "restart"; agentId: string }
  | { type: "restart-all" }
  | { type: "set-model-effort"; agentId: string; model: string; effort?: Effort }
  | { type: "prepare-new" }
  | { type: "list-projects"; serverUrl: string }
  | { type: "start-new"; answers: NewAgentAnswers }
  | { type: "open"; url: string };

export interface Update {
  state: ScreenState;
  commands: ScreenCommand[];
}

export interface Size {
  columns: number;
  rows: number;
}

export function initialState({ agents, selectedId, now, home, folder, freshStartAt }: { agents: HostAgent[]; selectedId?: string; now: number; home: string; folder: string; freshStartAt?: string }): ScreenState {
  const selected = agents.some((agent) => agent.id === selectedId) ? selectedId : agents[0]?.id;
  return { agents, selectedId: selected, logs: {}, loaded: {}, now, home, folder, freshStartAt };
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
  return { ...next, dialog: next.dialog && dialogStillValid(next, next.dialog) ? next.dialog : undefined };
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
    case "fresh-start":
      return { ...state, freshStartAt: event.freshStartAt };
    case "log-line": {
      // Only a run's latest progress is worth keeping: the screen would otherwise grow with every step.
      const { event: logged } = event.entry;
      const kept = (state.logs[event.agentId] ?? []).filter((e) => !(logged.type === "run-progress" && e.event.type === "run-progress" && e.event.workId === logged.workId));
      return { ...state, logs: { ...state.logs, [event.agentId]: [...kept, event.entry] } };
    }
  }
}

function nextSelection(agents: HostAgent[], removedId: string): string | undefined {
  const index = agents.findIndex((agent) => agent.id === removedId);
  return (agents[index + 1] ?? agents[index - 1])?.id;
}

export function onKey(state: ScreenState, key: Key): Update {
  if (state.dialog) return onDialogKey(state, state.dialog, key);
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
  if (key === "n") {
    const served = state.agents.find((agent) => agent.kind === "project" && agent.folder === state.folder);
    if (served) return { state: { ...state, selectedId: served.id }, commands: [] };
    return { state: { ...state, dialog: { type: "new", stage: "loading", servers: [], serverRow: 0, projects: [], row: 0, picked: 0, kept: 0, title: "", model: MODEL_CHOICES[0].id } }, commands: [{ type: "prepare-new" }] };
  }
  if (key === "o" && selected && selected.state !== "stopped") return { state, commands: [{ type: "open", url: addressOf(selected) }] };
  if (key === "m" && selected) return { state: { ...state, dialog: { type: "model", agentId: selected.id, field: "model", model: selected.model ?? MODEL_CHOICES[0].id, effort: selected.effort } }, commands: [] };
  if (key === "r" && selected?.state === "stopped") return { state, commands: [{ type: "restart", agentId: selected.id }] };
  if (key === "R" && state.agents.some((agent) => agent.state === "stopped")) return { state, commands: [{ type: "restart-all" }] };
  return { state, commands: [] };
}

/** The canvas of the run in progress, else the server's Agents screen. */
const addressOf = (agent: HostAgent): string => `${agent.serverUrl}/${agent.state === "running" && agent.run ? pageHash(agent.run.pageId) : agentsHash}`;

const closeDialog = (state: ScreenState): ScreenState => ({ ...state, dialog: undefined });

/** What a key does while a dialog is open: every key is for the dialog. */
function onDialogKey(state: ScreenState, dialog: Dialog, key: Key): Update {
  if (key === "escape") return { state: closeDialog(state), commands: [] };
  switch (dialog.type) {
    case "new":
      return onNewKey(state, dialog, key);
    case "stop":
      return key === "y" ? { state: closeDialog(state), commands: [{ type: "stop", agentId: dialog.agentId }] } : { state, commands: [] };
    case "model": {
      const agent = state.agents.find((a) => a.id === dialog.agentId);
      if (!agent) return { state: closeDialog(state), commands: [] };
      if (key === "up" || key === "down") return { state: { ...state, dialog: { ...dialog, field: key === "up" ? "model" : "effort" } }, commands: [] };
      if (key === "left" || key === "right") {
        const step = key === "left" ? -1 : 1;
        const next = (options: readonly (string | undefined)[], current: string | undefined) => options[Math.min(options.length - 1, Math.max(0, options.indexOf(current) + step))];
        return { state: { ...state, dialog: dialog.field === "model" ? { ...dialog, model: next(modelOptions(agent.model), dialog.model)! } : { ...dialog, effort: next(EFFORT_OPTIONS, dialog.effort) as Effort | undefined } }, commands: [] };
      }
      if (key === "enter") {
        const unchanged = dialog.model === agent.model && dialog.effort === agent.effort;
        return { state: closeDialog(state), commands: unchanged ? [] : [{ type: "set-model-effort", agentId: agent.id, model: dialog.model, effort: dialog.effort }] };
      }
      return { state, commands: [] };
    }
  }
}

/** A stop dialog is about a run: it goes with the run. The model dialog stays while its agent is listed, the new agent dialog is about no agent. */
function dialogStillValid(state: ScreenState, dialog: Dialog): boolean {
  if (dialog.type === "new") return true;
  const agent = state.agents.find((a) => a.id === dialog.agentId);
  return dialog.type === "stop" ? agent?.state === "running" : agent !== undefined;
}

// ---- New agent -------------------------------------------------------------------------------------------------

const MODEL_ROW = (dialog: NewAgentDialog) => (dialog.linkedTitles ? 0 : dialog.projects.length + 1);
const CREATE_ROW = (dialog: NewAgentDialog) => dialog.projects.length;

const withNew = (state: ScreenState, dialog: NewAgentDialog): Update => ({ state: { ...state, dialog }, commands: [] });

function openForm(dialog: NewAgentDialog, serverUrl: string, projects: ProjectOption[]): NewAgentDialog {
  return { ...dialog, stage: "form", serverUrl, projects, row: 0, picked: 0, kept: 0 };
}

/** The folder was inspected: ask for the server, or go to the form. */
export function newAgentQuestions(state: ScreenState, questions: NewAgentQuestions): ScreenState {
  if (state.dialog?.type !== "new") return state;
  const dialog: NewAgentDialog = { ...state.dialog, servers: questions.servers, model: questions.model, effort: questions.effort, linkedTitles: questions.linkedTitles };
  return { ...state, dialog: questions.serverUrl ? openForm(dialog, questions.serverUrl, questions.projects ?? []) : { ...dialog, stage: "server" } };
}

/** The projects of the server picked came back. */
export function projectsLoaded(state: ScreenState, serverUrl: string, projects: ProjectOption[]): ScreenState {
  return state.dialog?.type === "new" && state.dialog.stage === "loading" ? { ...state, dialog: openForm(state.dialog, serverUrl, projects) } : state;
}

/** Inspecting the folder, listing the projects or starting the agent failed: the dialog says why. */
export function newAgentFailed(state: ScreenState, message: string): ScreenState {
  if (state.dialog?.type !== "new") return state;
  const { dialog } = state;
  return { ...state, dialog: { ...dialog, busy: false, error: message, stage: dialog.stage === "loading" && dialog.servers.length > 1 && !dialog.serverUrl ? "server" : dialog.stage } };
}

/** The agent was started: the new dialog closes and the agent is selected (it may reach the list just after). */
export function agentStarted(state: ScreenState, agentId: string): ScreenState {
  return { ...state, selectedId: agentId, dialog: state.dialog?.type === "new" ? undefined : state.dialog };
}

function onNewKey(state: ScreenState, dialog: NewAgentDialog, key: Key): Update {
  if (dialog.stage === "loading" || dialog.busy) return { state, commands: [] };
  const clear = { ...dialog, error: undefined };
  if (dialog.stage === "server") {
    if (key === "up" || key === "down") return withNew(state, { ...clear, serverRow: Math.min(dialog.servers.length - 1, Math.max(0, dialog.serverRow + (key === "up" ? -1 : 1))) });
    if (key !== "enter") return { state, commands: [] };
    const serverUrl = dialog.servers[dialog.serverRow];
    return { state: { ...state, dialog: { ...clear, stage: "loading" } }, commands: [{ type: "list-projects", serverUrl }] };
  }
  const model = MODEL_ROW(dialog);
  if (key === "up" || key === "down") {
    const row = Math.min(model + 1, Math.max(0, dialog.row + (key === "up" ? -1 : 1)));
    if (dialog.linkedTitles) return withNew(state, { ...clear, row });
    const onProject = row <= CREATE_ROW(dialog);
    const leftEmptyCreate = !onProject && dialog.picked === CREATE_ROW(dialog) && !dialog.title.trim() && dialog.projects.length > 0;
    return withNew(state, { ...clear, row, picked: onProject ? row : leftEmptyCreate ? dialog.kept : dialog.picked, kept: onProject && row < CREATE_ROW(dialog) ? row : dialog.kept });
  }
  if (key === "left" || key === "right") {
    const step = key === "left" ? -1 : 1;
    const next = (options: readonly (string | undefined)[], current: string | undefined) => options[Math.min(options.length - 1, Math.max(0, options.indexOf(current) + step))];
    return withNew(state, dialog.row === model + 1 ? { ...clear, effort: next(EFFORT_OPTIONS, dialog.effort) as Effort | undefined } : { ...clear, model: next(modelOptions(dialog.model), dialog.model)! });
  }
  const onCreate = !dialog.linkedTitles && dialog.row === CREATE_ROW(dialog);
  if (key === "backspace") return onCreate ? withNew(state, { ...clear, title: [...dialog.title].slice(0, -1).join("") }) : { state, commands: [] };
  if (key === "enter") {
    const title = dialog.title.trim();
    const creating = !dialog.linkedTitles && dialog.picked === CREATE_ROW(dialog);
    if (creating && !title) return { state, commands: [] };
    const project = dialog.linkedTitles ? undefined : creating ? { create: title } : { existing: dialog.projects[dialog.picked].id };
    return { state: { ...state, dialog: { ...clear, busy: true } }, commands: [{ type: "start-new", answers: { serverUrl: dialog.serverUrl, ...(project ? { project } : {}), model: dialog.model, effort: dialog.effort } }] };
  }
  const typed = [...key].every((char) => char >= " " && char !== "\x7f");
  return onCreate && typed && key.length > 0 && !NAMED_KEYS.has(key) ? withNew(state, { ...clear, title: dialog.title + key }) : { state, commands: [] };
}

const NAMED_KEYS = new Set(["up", "down", "left", "right", "enter", "escape", "ctrl-c", "backspace"]);

/** The models of the launch choices, plus the full model id the agent may run with. */
const modelOptions = (model: string | undefined): string[] => [...MODEL_CHOICES.map((choice) => choice.id as string), ...(model && !MODEL_CHOICES.some((choice) => choice.id === model) ? [model] : [])];
/** `undefined` leaves the effort to Claude (shown as "default"). */
const EFFORT_OPTIONS: readonly (Effort | undefined)[] = [undefined, ...EFFORTS];

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

/** Every text of the screen is made here, so it is cleaned here (see `sanitizeForTerminal`). */
const span = (text: string, fg: string = C.text, bold = false, bg?: string): Span => ({ text: sanitizeForTerminal(text), fg, bold, bg });
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

const modelText = (model: string | undefined) => (model ? modelLabel(model) : "Claude's default");
const effortText = (effort: Effort | undefined) => effort ?? "Claude's default";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const folderLabel = (folder: string, home: string) => (home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder);

type RunStarted = Extract<HostLogEvent, { type: "run-started" }>;
const lastStarted = (log: HostLogEntry[]): RunStarted | undefined => log.map((e) => e.event).filter((e): e is RunStarted => e.type === "run-started").at(-1);
const placeOf = (project: string | undefined, page: string) => (project ? `${project} / ${page}` : page);

/** What an agent is doing, in one phrase: `running · Lumora Pro / Tarifs`. */
function activityLabel(agent: HostAgent, log: HostLogEntry[]): string {
  if (agent.state !== "running") return agent.state;
  const started = lastStarted(log);
  const page = agent.run?.page ?? started?.page;
  if (!page) return "running";
  return `running · ${placeOf(started?.page === page ? started.project : undefined, page)}`;
}

const STATE_COLOR: Record<HostAgent["state"], string> = { running: C.amber, idle: C.green, reconnecting: C.amber, stopped: C.dim };
const dot = (agent: HostAgent) => (agent.state === "stopped" ? "○" : "●");

// ---- Run log -------------------------------------------------------------------------------------------------

const TIME_WIDTH = 10;

function logRows(log: HostLogEntry[], now: number): Row[] {
  // A run's progress shows under its start line, its time counted from the start of the run, only while the run is in progress: a later end of the run, or of the worker, drops it.
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
        rows.push(line(at, span(`${wording.connected(event.serverUrl, event.kind)}.`, C.muted)));
        break;
      case "connection-lost":
        rows.push(line(at, span(wording.connectionLost(event.reason), C.muted)));
        break;
      case "reconnected":
        rows.push(line(at, span(wording.reconnected, C.muted)));
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
        if (latest && lastStart.get(event.workId) === index) rows.push(detail([...latest.steps.slice(-2), duration(now - Date.parse(at))].join(" · ")));
        break;
      }
      case "run-progress":
        break;
      case "run-published": {
        const place = placeOf(projects.get(event.workId), event.page);
        const outcome = publishedOutcome(event.changed, event.artboards);
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

/** The keys that apply to the selected agent. */
export function actionBar(state: ScreenState): BarItem[] {
  const agent = selectedAgent(state);
  const newHere = { key: "n", label: "new agent here" };
  if (agent?.state === "stopped") {
    return [
      { key: "↑↓", label: "agent" },
      { key: "r", label: "restart" },
      { key: "R", label: "restart all" },
      newHere,
      { key: "m", label: "model/effort" },
      { key: "x", label: "remove" },
      { key: "q", label: "close", muted: true },
    ];
  }
  const keys = agent ? [{ key: "↑↓", label: "agent" }, newHere, { key: "m", label: "model/effort" }, { key: "o", label: "open in Redline" }, { key: "x", label: "stop" }] : [newHere];
  return [...keys, { key: "q", label: "close · agents keep running", muted: true }];
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
    field("Model", modelText(agent.model)),
    field("Effort", effortText(agent.effort)),
    field("Account", agent.account ?? "unknown"),
    field("Machine", machine, C.muted),
  ];
}

/** After a fresh start of the host, while some agent is still stopped: says why, and which keys bring them back. */
function bannerRows(state: ScreenState, cells: number): Row[] {
  if (!state.freshStartAt || !state.agents.some((agent) => agent.state === "stopped")) return [];
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
    return [{ spans: [] }, { spans: [span(`${spaces(MARGIN)}No agent yet. Press n to start one in this folder.`, C.muted)] }];
  }
  const log = state.logs[agent.id] ?? [];
  const head = [...detailRows(state, agent, log, cells), ruleRow(), ...bannerRows(state, cells), { spans: [span(`${spaces(MARGIN)}LOG`, C.muted, true)] }];
  const lines = logRows(log, state.now).map((row) => ({ spans: [span(spaces(MARGIN)), ...row.spans] }));
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
    const model = modelText(agent.model);
    const nameLine = [
      span(isSelected ? "▎" : " ", C.red, false, bg),
      span(" ", C.text, false, bg),
      isSelected ? span("› ", C.red, true, bg) : span("  ", C.text, false, bg),
      span(`${dot(agent)} `, STATE_COLOR[agent.state], false, bg),
      span(name, stopped ? C.dim : C.text, isSelected, bg),
      span(agent.state.padStart(10), STATE_COLOR[agent.state], false, bg),
    ];
    const second = [span("    ", C.text, false, bg), span(`${model} · ${effortText(agent.effort)}`, C.dim, false, bg)];
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

/** The box a dialog draws: its width in cells, and its lines for a given inner width. */
interface DialogBox {
  width: number;
  /** Where the box starts, as a share of the free height (the boards place each dialog by hand). Default 0.4. */
  top?: number;
  rows(inner: number): Row[];
}

/** The shared frame of the dialogs: title, a separator, the body, a separator, and the keys on the darker bar. */
function dialogFrame(title: Span[], body: Row[], keys: BarItem[], inner: number): Row[] {
  const edge = (text: string, bg = C.bg) => span(text, C.muted, false, bg);
  const line = (bg: string, spans: Span[]): Row => ({ spans: [edge("│", bg), ...fit([span(" ", C.text, false, bg), ...spans.map((s) => ({ ...s, bg: s.bg ?? bg }))], inner, bg), edge("│", bg)] });
  const separator: Row = { spans: [edge("├"), span("─".repeat(inner), C.rule), edge("┤")] };
  return [
    { spans: [edge(`┌${"─".repeat(inner)}┐`)] },
    line(C.bg, title),
    separator,
    ...body.map((row) => line(C.bg, row.spans)),
    separator,
    line(C.bar, keyCaps(keys)),
    { spans: [edge(`└${"─".repeat(inner)}┘`)] },
  ];
}

/** The run in progress of an agent, as the dialogs name it: where, and since when. */
function runOf(state: ScreenState, agent: HostAgent): { place: string; elapsed: string } {
  const started = (state.logs[agent.id] ?? []).filter((entry) => entry.event.type === "run-started").at(-1);
  const run = started?.event as RunStarted | undefined;
  return { place: run ? placeOf(run.project, run.page) : (agent.run?.page ?? ""), elapsed: started ? ` (${duration(state.now - Date.parse(started.at))})` : "" };
}

function stopBox(state: ScreenState, agent: HostAgent): DialogBox {
  const { place, elapsed } = runOf(state, agent);
  const body = [
    [span("A run is in progress on ", C.muted), span(place), span(`${elapsed}.`, C.muted)],
    [span("Stopping cancels it; the conversation stays open in Redline.", C.muted)],
    [],
    [span("The agent stays in the list as stopped: ", C.dim), span("r", C.text, true), span(" restarts it, ", C.dim), span("x", C.text, true), span(" again removes it.", C.dim)],
  ];
  return { width: 90, rows: (inner) => dialogFrame([span(`Stop ${agent.name}?`, C.text, true)], body.map((spans) => ({ spans })), [{ key: "y", label: "stop" }, { key: "Esc", label: "keep running" }], inner) };
}

/** One row of choices: the picked one in a cap, white when its field is the active one. */
function choiceRow(label: string, active: boolean, options: string[], picked: number): Span[] {
  return [
    span(label.padEnd(LABEL_WIDTH), active ? C.text : C.dim, active),
    ...options.flatMap((option, index) => [index === picked ? span(` ${option} `, C.bg, true, active ? C.text : C.muted) : span(` ${option} `, C.muted), span(" ")]),
  ];
}

function modelBox(state: ScreenState, agent: HostAgent, dialog: Extract<Dialog, { type: "model" }>): DialogBox {
  const models = modelOptions(agent.model);
  const efforts = EFFORT_OPTIONS.map((effort) => effort ?? "default");
  const body: Span[][] = [choiceRow("Model", dialog.field === "model", models, models.indexOf(dialog.model)), choiceRow("Effort", dialog.field === "effort", efforts, EFFORT_OPTIONS.indexOf(dialog.effort))];
  if (agent.state === "running") {
    const { place } = runOf(state, agent);
    const current = `${modelText(agent.model)} · ${effortText(agent.effort)}`;
    body.push([], [span("! ", C.amber), span(`A run is in progress (${place}): it finishes with ${current}.`, C.muted)], [span("  The new choice applies from the next run, without restarting the agent.", C.muted)]);
  }
  const keys: BarItem[] = [{ key: "↑↓", label: "field" }, { key: "←→", label: "choice" }, { key: "Enter", label: "apply" }, { key: "Esc", label: "cancel" }];
  return { width: 82, rows: (inner) => dialogFrame([span("Model and effort", C.text, true), span(`  · ${agent.name}`, C.muted)], body.map((spans) => ({ spans })), keys, inner) };
}

/** One row of a radio list: the focused row has the red marker, the picked one is filled. */
function radioRow(label: Span[], focused: boolean, picked: boolean): Span[] {
  return [focused ? span("› ", C.red, true) : span("  "), picked ? span("● ", C.text) : span("○ ", C.dim), ...label];
}

function newBox(state: ScreenState, dialog: NewAgentDialog): DialogBox {
  const where = folderLabel(state.folder, state.home);
  const body: Span[][] = [];
  const keys: BarItem[] = [{ key: "Esc", label: "cancel" }];
  const known = dialog.stage !== "loading" || dialog.serverUrl !== undefined || dialog.error !== undefined;
  body.push(dialog.linkedTitles ? [span(where, C.muted), span(`  serves ${dialog.linkedTitles.join(", ")}.`, C.dim)] : known ? [span(where, C.muted), span("  isn't linked to a project yet.", C.dim)] : [span(where, C.muted)], []);
  if (dialog.stage === "loading" && !dialog.error) body.push([span("Checking this folder…", C.dim)]);
  if (dialog.stage === "server") {
    body.push([span("Server", C.text, true)], ...dialog.servers.map((url, index) => radioRow([span(url, index === dialog.serverRow ? C.text : C.muted)], index === dialog.serverRow, index === dialog.serverRow)));
    keys.unshift({ key: "↑↓", label: "server" }, { key: "Enter", label: "next" });
  }
  if (dialog.stage === "form") {
    const model = MODEL_ROW(dialog);
    if (!dialog.linkedTitles) {
      body.push([span("Project", C.text, true)]);
      dialog.projects.forEach((project, index) => body.push(radioRow([span(project.title, dialog.picked === index ? C.text : C.muted)], dialog.row === index, dialog.picked === index)));
      const create = CREATE_ROW(dialog);
      const focused = dialog.row === create;
      const title = focused ? span(` ${dialog.title}▏`, C.text, false, C.selected) : dialog.title ? span(` ${dialog.title} `, C.muted, false, C.selected) : span(" Project title ", C.dim, false, C.selected);
      body.push(radioRow([span("Create a new project:", dialog.picked === create ? C.text : C.muted), span("  "), title], focused, dialog.picked === create), []);
    }
    const models = modelOptions(dialog.model);
    const efforts = EFFORT_OPTIONS.map((effort) => effort ?? "default");
    body.push(choiceRow("Model", dialog.row <= model, models, models.indexOf(dialog.model)), choiceRow("Effort", dialog.row === model + 1, efforts, EFFORT_OPTIONS.indexOf(dialog.effort)), []);
    body.push(dialog.busy ? [span("Starting…", C.dim)] : [span("Last choice for this folder is preselected.", C.dim)]);
    keys.unshift({ key: "↑↓", label: "field" }, { key: "←→", label: "choice" }, { key: "Enter", label: "start" });
  }
  if (dialog.error) body.push([], [span("✗ ", C.red), span(dialog.error, C.muted)]);
  return { width: 82, top: 0.35, rows: (inner) => dialogFrame([span("New agent", C.text, true), span("  in the current folder", C.muted)], body.map((spans) => ({ spans })), keys, inner) };
}

function dialogBox(state: ScreenState, dialog: Dialog): DialogBox | undefined {
  if (dialog.type === "new") return newBox(state, dialog);
  const agent = state.agents.find((a) => a.id === dialog.agentId);
  if (!agent) return undefined;
  return dialog.type === "stop" ? stopBox(state, agent) : modelBox(state, agent, dialog);
}

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

  const asked = state.dialog && dialogBox(state, state.dialog);
  if (!asked) return frame.map((line) => toAnsi(line));
  const { width: wanted, rows: boxRows, top: topShare = 0.4 } = asked;
  const boxWidth = Math.min(wanted, columns - 4);
  const box = boxRows(boxWidth - 2);
  const top = Math.max(1, Math.floor((rows - box.length) * topShare));
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
