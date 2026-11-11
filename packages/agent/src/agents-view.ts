import { EFFORTS, MODEL_CHOICES, agentsHash, modelLabel, pageHash, type Effort } from "@redline/shared";
import { MIGRATE_STOP_REASON, publishedOutcome, wording } from "./activity.js";
import { sanitizeForTerminal } from "./sanitize.js";
import { COLOURS, span, width, spaces, clip, fit, toAnsi, ruleRow, clock, wrap, MARGIN, DETAIL_LABEL_WIDTH, listWindow, plural, folderLabel, addressText, type Span, type Row, type BarItem, type TabBody, type Key } from "./terminal-draw.js";
import { COMMANDS, commandCell } from "./commands-help.js";
import { commentsBar, commentsBody, commentsCount, commentsHeaderInstance, commentsOnKey, initialComments, type CommentsState } from "./comments-tab.js";
import type { FolderLine, InstanceEntry } from "./instance-list.js";
import { initialInstancesTab, instancesBar, instancesBody, instancesHeaderInstance, instancesOnKey, instancesProblems, instancesSummary, type InstancesTabState } from "./instances-tab.js";
import type { HostAgent, HostEvent, HostLogEntry, HostLogEvent } from "./host-protocol.js";
import type { NewAgentAnswers, NewAgentQuestions, ProjectOption } from "./new-agent.js";

/**
 * The agents screen as pure functions: state + key -> next state + commands, state + size -> frame lines.
 * Layout, colours and copy follow the `AgentsTui` and `AgentsTuiShell` boards of the Redline concept artifact.
 */

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
  /** The tab shown. A tab owns the keys and the body of its own (see `TABS`); the tab bar, the folder line and the bar of common keys are the screen's. */
  tab: TabId;
  /** Which side ←→ moved the focus to: the list on the right, or the detail pane on the left (the agents' log). ↑↓ act on it. */
  focus: Focus;
  /** Lines the log is scrolled up from its end. */
  logScroll: number;
  /** The installations on this computer. */
  instances: InstanceEntry[];
  /** What the "This folder" line says. */
  folderLine: FolderLine;
  /** The Comments tab: what waits for terminal sessions, the selected page and the scroll of its comments. */
  comments: CommentsState;
  /** What the Instances tab keeps: its selection, the diagnoses gathered, the action in progress. */
  instancesTab: InstancesTabState;
}

export type TabId = "agents" | "instances" | "comments";
export type Focus = "list" | "detail";
const TAB_ORDER: TabId[] = ["agents", "instances", "comments"];

/** A dialog open over the screen. Each type has its keys (`onDialogKey`), its box (`dialogBox`) and the condition that keeps it open (`dialogStillValid`). */
export type Dialog =
  | { type: "stop"; agentId: string }
  /** The choices being edited; they reach the host only on Enter. */
  | { type: "model"; agentId: string; field: "model" | "effort"; model: string; effort?: Effort }
  /** `?`: the keys and the commands. */
  | { type: "help" }
  /** `l` on a folder that is not linked, with several instances: which one. */
  | { type: "link"; row: number }
  | NewAgentDialog;

/**
 * `n`: the questions of a new agent. It opens `loading` while the folder is inspected, goes through `instance` when several are set up
 * and the folder is not linked, then `form`. The rows of the form are the projects, the create option, the model and the effort.
 * A folder not linked yet picks one project (radio rows); a linked folder ticks those its agent serves (checkbox rows).
 */
export interface NewAgentDialog {
  type: "new";
  stage: "loading" | "instance" | "form";
  /** The instances to pick from when several are set up and the folder is not linked. */
  instances: InstanceEntry[];
  instanceRow: number;
  serverUrl?: string;
  /** The titles of the projects of a linked folder: its projects are then ticked rather than picked. */
  linkedTitles?: string[];
  /** The projects ticked, for a linked folder. */
  ticked: string[];
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
  | { type: "open"; url: string }
  /** Links the folder to the instance (as `redline link` does). */
  | { type: "link-folder"; serverUrl: string }
  /** Gathers the diagnosis of an installation (the Instances tab). */
  | { type: "inspect-instance"; id: string }
  /** `redline update` for the installation. */
  | { type: "update-instance"; id: string }
  /** `redline remove` for the installation. */
  | { type: "remove-instance"; id: string };

export interface Update {
  state: ScreenState;
  commands: ScreenCommand[];
}

export interface Size {
  columns: number;
  rows: number;
}

export interface InitialState {
  agents: HostAgent[];
  selectedId?: string;
  now: number;
  home: string;
  folder: string;
  freshStartAt?: string;
  instances?: InstanceEntry[];
  folderLine?: FolderLine;
  tab?: TabId;
}

export function initialState({ agents, selectedId, now, home, folder, freshStartAt, instances = [], folderLine = { kind: "unlinked" }, tab = "agents" }: InitialState): ScreenState {
  const selected = agents.some((agent) => agent.id === selectedId) ? selectedId : agents[0]?.id;
  return { agents, selectedId: selected, logs: {}, loaded: {}, now, home, folder, freshStartAt, tab, focus: "list", logScroll: 0, instances, folderLine, comments: initialComments, instancesTab: initialInstancesTab() };
}

/** The folder was linked from the screen: the line says so. */
export const folderLinked = (state: ScreenState, folderLine: FolderLine): ScreenState => ({ ...state, folderLine });

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
  if (key === "q" || key === "ctrl-c") return { state, commands: [{ type: "close" }] };
  if (key === "?") return { state: { ...state, dialog: { type: "help" } }, commands: [] };
  if (key === "\t") return { state: switchTab(state, TAB_ORDER[(TAB_ORDER.indexOf(state.tab) + 1) % TAB_ORDER.length]), commands: [] };
  if (key === "1" || key === "2" || key === "3") return { state: switchTab(state, TAB_ORDER[Number(key) - 1]), commands: [] };
  if (key === "left" || key === "right") return { state: { ...state, focus: key === "left" ? "detail" : "list" }, commands: [] };
  if (key === "l" && state.folderLine.kind === "unlinked" && state.instances.length > 0) {
    if (state.instances.length === 1) return { state, commands: [{ type: "link-folder", serverUrl: state.instances[0].serverUrl }] };
    return { state: { ...state, dialog: { type: "link", row: 0 } }, commands: [] };
  }
  return TABS[state.tab].onKey(state, key);
}

const switchTab = (state: ScreenState, tab: TabId): ScreenState => ({ ...state, tab, focus: "list" });

/** Selecting an agent starts its log at the end again. */
const selectAgent = (state: ScreenState, agentId: string): ScreenState => ({ ...state, selectedId: agentId, logScroll: 0 });

function onAgentsKey(state: ScreenState, key: Key): Update {
  const index = state.agents.findIndex((agent) => agent.id === state.selectedId);
  if (key === "up" || key === "down") {
    if (state.focus === "detail") {
      const agent = selectedAgent(state);
      const last = agent ? Math.max(0, logRows(state.logs[agent.id] ?? [], state.now, 0).length - 1) : 0;
      return { state: { ...state, logScroll: Math.min(last, Math.max(0, state.logScroll + (key === "up" ? 1 : -1))) }, commands: [] };
    }
    const next = state.agents[Math.min(state.agents.length - 1, Math.max(0, index + (key === "up" ? -1 : 1)))];
    return { state: next && next.id !== state.selectedId ? selectAgent(state, next.id) : state, commands: [] };
  }
  const selected = selectedAgent(state);
  if (key === "x" && selected) {
    if (selected.state === "running") return { state: { ...state, dialog: { type: "stop", agentId: selected.id } }, commands: [] };
    return { state, commands: [{ type: selected.state === "stopped" ? "remove" : "stop", agentId: selected.id }] };
  }
  if (key === "n") {
    const served = state.agents.find((agent) => agent.kind === "project" && agent.folder === state.folder);
    if (served) return { state: selectAgent(state, served.id), commands: [] };
    return { state: { ...state, dialog: { type: "new", stage: "loading", instances: [], instanceRow: 0, projects: [], ticked: [], row: 0, picked: 0, kept: 0, title: "", model: MODEL_CHOICES[0].id } }, commands: [{ type: "prepare-new" }] };
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
    case "help":
      return key === "?" ? { state: closeDialog(state), commands: [] } : { state, commands: [] };
    case "link": {
      if (key === "up" || key === "down") return { state: { ...state, dialog: { ...dialog, row: Math.min(state.instances.length - 1, Math.max(0, dialog.row + (key === "up" ? -1 : 1))) } }, commands: [] };
      return key === "enter" ? { state: closeDialog(state), commands: [{ type: "link-folder", serverUrl: state.instances[dialog.row].serverUrl }] } : { state, commands: [] };
    }
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
  if (dialog.type === "new" || dialog.type === "help" || dialog.type === "link") return true;
  const agent = state.agents.find((a) => a.id === dialog.agentId);
  return dialog.type === "stop" ? agent?.state === "running" : agent !== undefined;
}

// ---- New agent -------------------------------------------------------------------------------------------------

const MODEL_ROW = (dialog: NewAgentDialog) => dialog.projects.length + 1;
const CREATE_ROW = (dialog: NewAgentDialog) => dialog.projects.length;

const withNew = (state: ScreenState, dialog: NewAgentDialog): Update => ({ state: { ...state, dialog }, commands: [] });

function openForm(dialog: NewAgentDialog, serverUrl: string, projects: ProjectOption[]): NewAgentDialog {
  return { ...dialog, stage: "form", serverUrl, projects, row: 0, picked: 0, kept: 0 };
}

/** The folder was inspected: ask for the instance, or go to the form. */
export function newAgentQuestions(state: ScreenState, questions: NewAgentQuestions): ScreenState {
  if (state.dialog?.type !== "new") return state;
  const dialog: NewAgentDialog = { ...state.dialog, instances: questions.instances, model: questions.model, effort: questions.effort, linkedTitles: questions.linkedTitles, ticked: questions.linkedIds ?? [] };
  return { ...state, dialog: questions.serverUrl ? openForm(dialog, questions.serverUrl, questions.projects ?? []) : { ...dialog, stage: "instance" } };
}

/** The projects of the instance picked came back. */
export function projectsLoaded(state: ScreenState, serverUrl: string, projects: ProjectOption[]): ScreenState {
  return state.dialog?.type === "new" && state.dialog.stage === "loading" ? { ...state, dialog: openForm(state.dialog, serverUrl, projects) } : state;
}

/** Inspecting the folder, listing the projects or starting the agent failed: the dialog says why. */
export function newAgentFailed(state: ScreenState, message: string): ScreenState {
  if (state.dialog?.type !== "new") return state;
  const { dialog } = state;
  return { ...state, dialog: { ...dialog, busy: false, error: message, stage: dialog.stage === "loading" && dialog.instances.length > 1 && !dialog.serverUrl ? "instance" : dialog.stage } };
}

/** The agent was started: the new dialog closes and the agent is selected (it may reach the list just after). */
export function agentStarted(state: ScreenState, agentId: string): ScreenState {
  return { ...state, selectedId: agentId, dialog: state.dialog?.type === "new" ? undefined : state.dialog };
}

function onNewKey(state: ScreenState, dialog: NewAgentDialog, key: Key): Update {
  if (dialog.stage === "loading" || dialog.busy) return { state, commands: [] };
  const clear = { ...dialog, error: undefined };
  if (dialog.stage === "instance") {
    if (key === "up" || key === "down") return withNew(state, { ...clear, instanceRow: Math.min(dialog.instances.length - 1, Math.max(0, dialog.instanceRow + (key === "up" ? -1 : 1))) });
    if (key !== "enter") return { state, commands: [] };
    const picked = dialog.instances[dialog.instanceRow];
    if (picked.tooOld) return withNew(state, { ...clear, error: `${picked.name} is too old for this command: it must be updated first (Instances tab).` });
    const serverUrl = picked.serverUrl;
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
  const onCreate = dialog.row === CREATE_ROW(dialog);
  if (key === " " && dialog.linkedTitles && dialog.row < CREATE_ROW(dialog)) {
    const project = dialog.projects[dialog.row];
    if (project.takenBy) return { state, commands: [] };
    const ticked = dialog.ticked.includes(project.id) ? dialog.ticked.filter((id) => id !== project.id) : [...dialog.ticked, project.id];
    return withNew(state, { ...clear, ticked });
  }
  if (key === "backspace") return onCreate ? withNew(state, { ...clear, title: [...dialog.title].slice(0, -1).join("") }) : { state, commands: [] };
  if (key === "enter") {
    const title = dialog.title.trim();
    const start = (choice: Pick<NewAgentAnswers, "project" | "serve">): Update => ({
      state: { ...state, dialog: { ...clear, busy: true } },
      commands: [{ type: "start-new", answers: { serverUrl: dialog.serverUrl, ...choice, model: dialog.model, effort: dialog.effort } }],
    });
    if (dialog.linkedTitles) {
      // Listed in the order of the rows, whatever the order they were ticked in.
      const projectIds = dialog.projects.filter((p) => dialog.ticked.includes(p.id)).map((p) => p.id);
      if (projectIds.length === 0 && !title) return withNew(state, { ...clear, error: "Tick at least one project." });
      return start({ serve: { projectIds, ...(title ? { create: title } : {}) } });
    }
    const creating = dialog.picked === CREATE_ROW(dialog);
    if (creating && !title) return { state, commands: [] };
    return start({ project: creating ? { create: title } : { existing: dialog.projects[dialog.picked].id } });
  }
  const typed = [...key].every((char) => char >= " " && char !== "\x7f");
  return onCreate && typed && key.length > 0 && !NAMED_KEYS.has(key) ? withNew(state, { ...clear, title: dialog.title + key }) : { state, commands: [] };
}

const NAMED_KEYS = new Set(["up", "down", "left", "right", "enter", "escape", "ctrl-c", "backspace"]);

/** The models of the launch choices, plus the full model id the agent may run with. */
const modelOptions = (model: string | undefined): string[] => [...MODEL_CHOICES.map((choice) => choice.id as string), ...(model && !MODEL_CHOICES.some((choice) => choice.id === model) ? [model] : [])];
/** `undefined` leaves the effort to Claude (shown as "default"). */
const EFFORT_OPTIONS: readonly (Effort | undefined)[] = [undefined, ...EFFORTS];

// ---- Formatting ----------------------------------------------------------------------------------------------

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

type RunStarted = Extract<HostLogEvent, { type: "run-started" }>;
const lastStarted = (log: HostLogEntry[]): RunStarted | undefined => log.map((e) => e.event).filter((e): e is RunStarted => e.type === "run-started").at(-1);
const placeOf = (project: string | undefined, page: string) => (project ? `${project} › ${page}` : page);

/** What an agent is doing, in one phrase: `running · Lumora Pro / Tarifs`. */
function activityLabel(agent: HostAgent, log: HostLogEntry[]): string {
  if (agent.state !== "running") return agent.state;
  const started = lastStarted(log);
  const page = agent.run?.page ?? started?.page;
  if (!page) return "running";
  return `running · ${placeOf(started?.page === page ? started.project : undefined, page)}`;
}

const STATE_COLOR: Record<HostAgent["state"], string> = { running: COLOURS.amber, idle: COLOURS.green, reconnecting: COLOURS.amber, stopped: COLOURS.dim };
const dot = (agent: HostAgent) => (agent.state === "stopped" ? "○" : "●");

// ---- Run log -------------------------------------------------------------------------------------------------

const TIME_WIDTH = 10;
const LABEL_COLUMN = 14;
/** Where what an event says starts, after the time, the glyph and the label. */
const VALUE_COLUMN = TIME_WIDTH + 2 + LABEL_COLUMN;

/** `cells` is the width the lines may take; a refusal wraps under its first line within it (0: no wrapping). */
function logRows(log: HostLogEntry[], now: number, cells: number, where: (serverUrl: string) => string = (serverUrl) => serverUrl): Row[] {
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
      case "host-updated":
        progress.clear();
        break;
    }
  });

  const rows: Row[] = [];
  const line = (at: string, ...rest: Span[]): Row => ({ spans: [span(`${clock(at)}  `, COLOURS.dim), ...rest] });
  const detail = (text: string): Row => ({ spans: [span(`${spaces(VALUE_COLUMN)}  ${text}`, COLOURS.dim)] });
  /** The events' labels share a column, so that what they say lines up (a label as wide as the column keeps two spaces). */
  const labelled = (label: string) => `${label.padEnd(LABEL_COLUMN)}${label.length >= LABEL_COLUMN ? "  " : ""}`;
  const title = (glyph: string, color: string, label: string) => [span(`${glyph} `, color), span(labelled(label), COLOURS.text, true)];

  log.forEach(({ at, event }, index) => {
    switch (event.type) {
      case "connected":
        rows.push(line(at, ...title("●", COLOURS.green, "Connected"), span(where(event.serverUrl), COLOURS.muted)));
        break;
      case "connection-lost":
        rows.push(line(at, span(wording.connectionLost(event.reason), COLOURS.muted)));
        break;
      case "reconnected":
        rows.push(line(at, span(wording.reconnected, COLOURS.muted)));
        break;
      case "refused":
        {
          const lead = VALUE_COLUMN;
          const [first = "", ...more] = cells > lead + 10 ? wrap(event.reason, cells - lead) : [event.reason];
          rows.push(line(at, ...title("✗", COLOURS.red, "Refused"), span(first, COLOURS.muted)));
          for (const rest of more) rows.push({ spans: [span(spaces(lead)), span(rest, COLOURS.muted)] });
        }
        break;
      case "run-started": {
        const who = event.author ? ` ${event.kind === "conversation" ? "with" : "by"} ${event.author}` : "";
        const attempt = event.attempt > 1 ? ` · attempt ${event.attempt}` : "";
        rows.push(line(at, ...title("▸", COLOURS.amber, "Run started"), span(placeOf(event.project, event.page)), span(`  ${event.kind}${who}${attempt}`, COLOURS.muted)));
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
        rows.push(line(at, ...title("✓", COLOURS.green, event.changed.length > 0 ? "Published" : "Finished"), span(place), span(`  ${outcome} · ${duration(event.durationMs)}`, COLOURS.muted)));
        break;
      }
      case "run-failed":
        rows.push(line(at, ...title("✗", COLOURS.red, "Run failed"), span(placeOf(projects.get(event.workId), event.page)), span(`  ${event.reason}`, COLOURS.muted)));
        break;
      case "host-updated":
        rows.push(line(at, span("↻ ", COLOURS.muted), span(labelled("Host restarted"), COLOURS.text, true), span(`redline command changed to v${event.version}`, COLOURS.muted)));
        rows.push({ spans: [span(`${spaces(VALUE_COLUMN)}(waited for the runs in progress)`, COLOURS.dim)] });
        break;
      case "stopped":
        if (event.reason === "failed") rows.push(line(at, ...title("✗", COLOURS.red, "Stopped"), span(event.error, COLOURS.muted)));
        else {
          const why = { updated: "updating, restarting", stopped: "stopped on request", "host-restarted": "the Mac restarted or the session closed" }[event.reason];
          rows.push(line(at, span("○ Stopped", COLOURS.muted, true), span(`  ${why}`, COLOURS.dim)));
        }
        break;
    }
  });
  return rows;
}

// ---- Screen --------------------------------------------------------------------------------------------------

const RIGHT_WIDTH = 46;
const LABEL_WIDTH = 10;
/** Rows of the screen around the body: the blank row, header, folder line, blank row, tabs, two rules and the key bar. */
const CHROME_ROWS = 8;
/** The first row of the body on screen: the board lets the commands box start there. */
const TOP_ROW = 6;

/**
 * A tab of the home screen. The screen draws the header, the folder line, the tab bar and the common keys (Tab, 1 2 3, ←→, ?, q, l);
 * a tab brings its own state (a field of `ScreenState`), its keys (`onKey`, called for the keys the screen did not take, ↑↓ included, with
 * `state.focus` telling the side), its body (the left pane, `detail`, and the right pane, `list`), the keys it adds to the bar, its count
 * and its header text. Tests drive a tab with `onKey` and `render`.
 */
interface TabDef {
  label: string;
  count(state: ScreenState): number;
  /** The "! n" next to the count, when n > 0. */
  problems?(state: ScreenState): number;
  /** What the header says on the right, instead of the agents' counts. */
  summary?(state: ScreenState): Span[];
  /** The instance the header names, when the tab has a selection that belongs to one. */
  headerInstance(state: ScreenState): string | undefined;
  onKey(state: ScreenState, key: Key): Update;
  /** The keys of the bar before the common ones. */
  bar(state: ScreenState): BarItem[];
  body(state: ScreenState, size: { left: number; right: number; height: number }): TabBody;
}

const TABS: Record<TabId, TabDef> = {
  agents: {
    label: "Agents",
    count: (state) => state.agents.length,
    headerInstance: (state) => {
      const agent = selectedAgent(state);
      return agent ? instanceLabel(state, agent) : undefined;
    },
    onKey: onAgentsKey,
    bar: agentsBar,
    body: (state, { left, right, height }) => ({ left: leftColumn(state, left, height), right: rightColumn(state, right, height) }),
  },
  instances: {
    label: "Instances",
    count: (state) => state.instances.length,
    problems: instancesProblems,
    headerInstance: instancesHeaderInstance,
    summary: instancesSummary,
    onKey: instancesOnKey,
    bar: instancesBar,
    body: instancesBody,
  },
  // Wrapped: comments-tab.ts imports this module back, so its names may not be bound yet when TABS is built.
  comments: { label: "Comments", count: (state) => commentsCount(state), headerInstance: (state) => commentsHeaderInstance(state), onKey: (state, key) => commentsOnKey(state, key), bar: (state) => commentsBar(state), body: (state, size) => commentsBody(state, size) },
};

/** The keys that apply to the selected agent. */
function agentsBar(state: ScreenState): BarItem[] {
  const agent = selectedAgent(state);
  const move = [{ key: "↑↓", label: "agent" }, { key: "←→", label: "log/list" }];
  if (agent?.state === "stopped") return [...move, { key: "r", label: "restart" }, { key: "R", label: "restart all" }, { key: "x", label: "remove" }];
  return agent ? [...move, { key: "n", label: "new" }, { key: "m", label: "model" }, { key: "x", label: "stop" }] : [{ key: "n", label: "new" }];
}

/** The keys shown on the bar: the tab's, then the screen's. */
export const actionBar = (state: ScreenState): BarItem[] => [...TABS[state.tab].bar(state), { key: "?", label: "commands" }, { key: "Tab", label: "next tab" }, { key: "q", label: "close", muted: true }];

function selectedAgent(state: ScreenState): HostAgent | undefined {
  return state.agents.find((agent) => agent.id === state.selectedId);
}

const sameAddress = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
const instanceOf = (state: ScreenState, agent: HostAgent): InstanceEntry | undefined =>
  state.instances.find((entry) => (agent.installation ? entry.id === agent.installation : sameAddress(entry.serverUrl, agent.serverUrl))) ?? state.instances.find((entry) => sameAddress(entry.serverUrl, agent.serverUrl));
const instanceText = (entry: Pick<InstanceEntry, "name" | "serverUrl" | "version">) => [entry.name, addressText(entry.serverUrl), ...(entry.version ? [`v${entry.version}`] : [])].join(" · ");
const instanceLabel = (state: ScreenState, agent: HostAgent): string => {
  const entry = instanceOf(state, agent);
  return entry ? `${entry.name} · ${addressText(entry.serverUrl)}` : addressText(agent.serverUrl);
};

function headerRow(state: ScreenState, columns: number): Row {
  const runs = state.agents.filter((a) => a.state === "running").length;
  const allStopped = state.agents.length > 0 && state.agents.every((a) => a.state === "stopped");
  const where = TABS[state.tab].headerInstance(state);
  const left = [span("redline", COLOURS.text, true), ...(where ? [span(`  ${where}`, COLOURS.dim)] : [])];
  const right = TABS[state.tab].summary?.(state) ?? [
    span(plural(state.agents.length, "agent"), COLOURS.muted),
    span(" · ", COLOURS.dim),
    allStopped ? span("all stopped", COLOURS.dim) : runs > 0 ? span(`${plural(runs, "run")} in progress`, COLOURS.amber) : span("no run in progress", COLOURS.dim),
  ];
  const gap = columns - 2 * MARGIN - width(left) - width(right);
  return { spans: [span(spaces(MARGIN)), ...left, span(spaces(gap)), ...right] };
}

/** "This folder ~/claude-projects/agora → Agora on Lumora", or what is missing. */
function folderRow(state: ScreenState): Row {
  const { folderLine: line } = state;
  const head = [span(spaces(MARGIN)), span("This folder ", COLOURS.dim), span(folderLabel(state.folder, state.home), COLOURS.muted)];
  if (line.kind === "linked") return { spans: [...head, span(" → ", COLOURS.dim), ...(line.project ? [span(line.project, COLOURS.text, true), span(" on ", COLOURS.muted)] : []), span(line.instance, COLOURS.text, true)] };
  if (line.kind === "orphan") return { spans: [...head, span(`  linked to ${line.address}, which is not installed here · `, COLOURS.dim), span("redline setup", COLOURS.text, true)] };
  return { spans: [...head, span("  not linked to an instance · ", COLOURS.dim), span("l", COLOURS.text, true), span(" links it", COLOURS.dim)] };
}

/** The tabs: the shown one in a cap, the others muted, their counts, the instances' problems, and the key that switches. */
function tabRow(state: ScreenState): Row {
  const spans: Span[] = [span(spaces(MARGIN))];
  for (const id of TAB_ORDER) {
    const tab = TABS[id];
    const shown = id === state.tab;
    const problems = tab.problems?.(state) ?? 0;
    spans.push(shown ? span(` ${tab.label} `, COLOURS.bg, true, COLOURS.text) : span(` ${tab.label} `, COLOURS.muted), span(` ${tab.count(state)}`, shown ? COLOURS.text : COLOURS.dim, shown), ...(problems > 0 ? [span(` ! ${problems}`, COLOURS.amber)] : []), span("    "));
  }
  spans.push(span(" "), span("Tab", COLOURS.text, true), span(" switches", COLOURS.dim));
  return { spans };
}

function detailRows(state: ScreenState, agent: HostAgent, log: HostLogEntry[], cells: number): Row[] {
  const status =
    agent.state === "stopped"
      ? [span(`○ stopped since ${clock(agent.since, false)}`, COLOURS.dim)]
      : agent.state === "running"
        ? [span(`● ${activityLabel(agent, log)}`, COLOURS.amber)]
        : [span(`● ${agent.state} since ${clock(agent.since, false)}`, STATE_COLOR[agent.state])];
  const left = [span(agent.name, COLOURS.text, true), span("  "), span(folderLabel(agent.folder, state.home), COLOURS.muted)];
  const gap = cells - 2 * MARGIN - width(left) - width(status);
  const field = (label: string, value: string, color: string = COLOURS.text): Row => ({ spans: [span(spaces(MARGIN)), span(label.padEnd(DETAIL_LABEL_WIDTH), COLOURS.dim), span(value, color)] });
  const projects = agent.kind === "global" ? "All projects" : (agent.projectNames?.join(", ") ?? "-");
  const machine = [agent.machine ?? "-", ...(agent.state !== "stopped" && agent.startedAt ? [`up ${uptime(state.now - Date.parse(agent.startedAt))}`] : [])].join(" · ");
  const instance = instanceOf(state, agent);
  return [
    { spans: [] },
    { spans: [span(spaces(MARGIN)), ...left, span(spaces(gap)), ...status] },
    field("Instance", instance ? instanceText(instance) : addressText(agent.serverUrl), instance?.tooOld ? COLOURS.amber : COLOURS.text),
    field("Projects", projects),
    field("Model", modelText(agent.model)),
    field("Effort", effortText(agent.effort)),
    field("Account", agent.account ?? "unknown"),
    field("Machine", machine, COLOURS.muted),
  ];
}

/** Says why the agents are stopped, and which keys bring them back: `redline migrate` stopped the selected one, or the host started fresh while some agent is still stopped. */
function bannerRows(state: ScreenState, agent: HostAgent, cells: number): Row[] {
  const migrated = agent.state === "stopped" && agent.reason === MIGRATE_STOP_REASON;
  if (!migrated && (!state.freshStartAt || !state.agents.some((a) => a.state === "stopped"))) return [];
  const inner = cells - 2 * MARGIN - 2;
  const edge = (text: string) => span(text, COLOURS.rule, false, COLOURS.bar);
  const line = (...content: Span[]): Row => ({ spans: [span(spaces(MARGIN)), edge("│"), ...fit([span(" ", COLOURS.text, false, COLOURS.bar), ...content.map((s) => ({ ...s, bg: COLOURS.bar }))], inner, COLOURS.bar), edge("│")] });
  const border = (left: string, right: string): Row => ({ spans: [span(spaces(MARGIN)), edge(`${left}${"─".repeat(inner)}${right}`)] });
  const why = migrated ? MIGRATE_STOP_REASON : `The agents stopped (the Mac restarted or the session closed at ${clock(state.freshStartAt!, false)}).`;
  return [
    border("┌", "┐"),
    line(span("○ ", COLOURS.dim), span(why, COLOURS.muted)),
    line(span("  "), span("r", COLOURS.text, true), span(" restarts the selected one with the same folder, model and effort · ", COLOURS.muted), span("R", COLOURS.text, true), span(" restarts all.", COLOURS.muted)),
    border("└", "┘"),
  ];
}

function leftColumn(state: ScreenState, cells: number, height: number): Row[] {
  const agent = selectedAgent(state);
  if (!agent) {
    return [{ spans: [] }, { spans: [span(`${spaces(MARGIN)}No agent yet. Press n to start one in this folder.`, COLOURS.muted)] }];
  }
  const log = state.logs[agent.id] ?? [];
  const scrolling = state.focus === "detail";
  const title = [scrolling ? span("▎", COLOURS.red) : span(" "), span(" "), span("LOG", COLOURS.muted, true), span(scrolling ? "  ↑↓ scroll · → back to the list" : "  ← to scroll it", COLOURS.dim)];
  const head = [...detailRows(state, agent, log, cells), ruleRow(), ...bannerRows(state, agent, cells), { spans: title }];
  const lines = logRows(log, state.now, cells - 2 * MARGIN, (serverUrl) => {
    const entry = state.instances.find((candidate) => sameAddress(candidate.serverUrl, serverUrl));
    return entry ? instanceText(entry) : addressText(serverUrl);
  }).map((row) => ({ spans: [span(spaces(MARGIN)), ...row.spans] }));
  const room = Math.max(0, height - head.length);
  const end = Math.max(Math.min(room, lines.length), lines.length - state.logScroll);
  return [...head, ...lines.slice(Math.max(0, end - room), end)];
}

function rightColumn(state: ScreenState, cells: number, height: number): Row[] {
  const selected = Math.max(0, state.agents.findIndex((agent) => agent.id === state.selectedId));
  const { first, shown } = listWindow(state.agents.length, selected, height);
  const above = first;
  const below = state.agents.length - first - shown;
  const more = (text: string): Row => ({ spans: [span(`${spaces(MARGIN)}${text}`, COLOURS.dim)] });
  const rows: Row[] = [above > 0 ? more(`↑ ${above} more`) : { spans: [] }];
  const nameWidth = Math.max(16, ...state.agents.map((agent) => [...agent.name].length));
  const marker = state.focus === "list" ? COLOURS.red : COLOURS.dim;
  for (const agent of state.agents.slice(first, first + shown)) {
    const isSelected = agent.id === state.selectedId;
    const bg = isSelected ? COLOURS.selected : undefined;
    const stopped = agent.state === "stopped";
    const name = clip([span(agent.name)], nameWidth).map((s) => s.text).join("").padEnd(nameWidth);
    const entry = instanceOf(state, agent);
    const second = [span("    ", COLOURS.text, false, bg), span(`${entry?.name ?? addressText(agent.serverUrl)} · ${agent.model || agent.effort ? `${modelText(agent.model)} · ${effortText(agent.effort)}` : modelText(undefined)}`, COLOURS.dim, false, bg)];
    const nameLine = [
      span(isSelected ? "▎" : " ", marker, false, bg),
      span(" ", COLOURS.text, false, bg),
      isSelected ? span("› ", marker, true, bg) : span("  ", COLOURS.text, false, bg),
      span(`${dot(agent)} `, STATE_COLOR[agent.state], false, bg),
      span(name, stopped ? COLOURS.dim : COLOURS.text, isSelected, bg),
      span(agent.state.padStart(10), STATE_COLOR[agent.state], false, bg),
    ];
    rows.push({ spans: fit(nameLine, cells, bg) });
    rows.push({ spans: fit([span(isSelected ? "▎" : " ", marker, false, bg), span(" ", COLOURS.text, false, bg), ...second], cells, bg) });
    rows.push({ spans: [] });
  }
  if (below > 0) rows.push(more(`↓ ${below} more`));
  return rows;
}

/** Inverse-video key caps, each followed by its label. */
function keyCaps(items: BarItem[]): Span[] {
  return items.flatMap((item) => [span(` ${item.key} `, COLOURS.bg, true, item.muted ? COLOURS.muted : COLOURS.text), span(" ", COLOURS.muted, false, COLOURS.bar), span(item.label, COLOURS.muted, false, COLOURS.bar), span("   ", COLOURS.muted, false, COLOURS.bar)]);
}

const barRow = (state: ScreenState, columns: number): Span[] => fit([span(spaces(MARGIN), COLOURS.text, false, COLOURS.bar), ...keyCaps(actionBar(state))], columns, COLOURS.bar);

// ---- Dialogs -------------------------------------------------------------------------------------------------

/** The board dims the screen behind a dialog with 55 % black. */
const DIM = 0.45;
const dimmed = (hex: string) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * DIM).toString(16).padStart(2, "0")).join("")}`;
const dim = (spans: Span[]): Span[] => spans.map((s) => ({ ...s, fg: dimmed(s.fg ?? COLOURS.text), bg: dimmed(s.bg ?? COLOURS.bg) }));

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
  /** Or the screen row it starts at. */
  row?: number;
  rows(inner: number): Row[];
}

/** The shared frame of the dialogs: title, a separator, the body, a separator, and the keys on the darker bar. */
function dialogFrame(title: Span[], body: Row[], keys: BarItem[], inner: number): Row[] {
  const edge = (text: string, bg = COLOURS.bg) => span(text, COLOURS.muted, false, bg);
  const line = (bg: string, spans: Span[]): Row => ({ spans: [edge("│", bg), ...fit([span(" ", COLOURS.text, false, bg), ...spans.map((s) => ({ ...s, bg: s.bg ?? bg }))], inner, bg), edge("│", bg)] });
  const separator: Row = { spans: [edge("├"), span("─".repeat(inner), COLOURS.rule), edge("┤")] };
  return [
    { spans: [edge(`┌${"─".repeat(inner)}┐`)] },
    line(COLOURS.bg, title),
    separator,
    ...body.map((row) => line(COLOURS.bg, row.spans)),
    separator,
    line(COLOURS.bar, keyCaps(keys)),
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
    [span("A run is in progress on ", COLOURS.muted), span(place), span(`${elapsed}.`, COLOURS.muted)],
    [span("Stopping cancels it; the conversation stays open in Redline.", COLOURS.muted)],
    [],
    [span("The agent stays in the list as stopped: ", COLOURS.dim), span("r", COLOURS.text, true), span(" restarts it, ", COLOURS.dim), span("x", COLOURS.text, true), span(" again removes it.", COLOURS.dim)],
  ];
  return { width: 90, rows: (inner) => dialogFrame([span(`Stop ${agent.name}?`, COLOURS.text, true)], body.map((spans) => ({ spans })), [{ key: "y", label: "stop" }, { key: "Esc", label: "keep running" }], inner) };
}

/** One row of choices: the picked one in a cap, white when its field is the active one. */
function choiceRow(label: string, active: boolean, options: string[], picked: number): Span[] {
  return [
    span(label.padEnd(LABEL_WIDTH), active ? COLOURS.text : COLOURS.dim, active),
    ...options.flatMap((option, index) => [index === picked ? span(` ${option} `, COLOURS.bg, true, active ? COLOURS.text : COLOURS.muted) : span(` ${option} `, COLOURS.muted), span(" ")]),
  ];
}

function modelBox(state: ScreenState, agent: HostAgent, dialog: Extract<Dialog, { type: "model" }>): DialogBox {
  const models = modelOptions(agent.model);
  const efforts = EFFORT_OPTIONS.map((effort) => effort ?? "default");
  const body: Span[][] = [choiceRow("Model", dialog.field === "model", models, models.indexOf(dialog.model)), choiceRow("Effort", dialog.field === "effort", efforts, EFFORT_OPTIONS.indexOf(dialog.effort))];
  if (agent.state === "running") {
    const { place } = runOf(state, agent);
    const current = `${modelText(agent.model)} · ${effortText(agent.effort)}`;
    body.push([], [span("! ", COLOURS.amber), span(`A run is in progress (${place}): it finishes with ${current}.`, COLOURS.muted)], [span("  The new choice applies from the next run, without restarting the agent.", COLOURS.muted)]);
  }
  const keys: BarItem[] = [{ key: "↑↓", label: "field" }, { key: "←→", label: "choice" }, { key: "Enter", label: "apply" }, { key: "Esc", label: "cancel" }];
  return { width: 82, rows: (inner) => dialogFrame([span("Model and effort", COLOURS.text, true), span(`  · ${agent.name}`, COLOURS.muted)], body.map((spans) => ({ spans })), keys, inner) };
}

/** One row of a radio list: the focused row has the red marker, the picked one is filled. */
function radioRow(label: Span[], focused: boolean, picked: boolean): Span[] {
  return [focused ? span("› ", COLOURS.red, true) : span("  "), picked ? span("● ", COLOURS.text) : span("○ ", COLOURS.dim), ...label];
}

/** The field of the project to create: the cursor while focused, else the title typed or a placeholder. */
function titleField(dialog: NewAgentDialog, focused: boolean): Span {
  if (focused) return span(` ${dialog.title}▏`, COLOURS.text, false, COLOURS.selected);
  return dialog.title ? span(` ${dialog.title} `, COLOURS.muted, false, COLOURS.selected) : span(" Project title ", COLOURS.dim, false, COLOURS.selected);
}

/** The projects of a linked folder, as a checklist: a project served by another agent cannot be ticked. */
function tickRows(dialog: NewAgentDialog): Span[][] {
  const marker = (row: number) => (dialog.row === row ? span("› ", COLOURS.red, true) : span("  "));
  const rows = dialog.projects.map((project, index) => {
    const ticked = dialog.ticked.includes(project.id);
    const box = project.takenBy ? span("– ", COLOURS.dim) : ticked ? span("■ ", COLOURS.text) : span("□ ", COLOURS.dim);
    const served = project.takenBy ? [span(`  served by ${project.takenBy}`, COLOURS.dim)] : [];
    return [marker(index), box, span(project.title, project.takenBy ? COLOURS.dim : ticked ? COLOURS.text : COLOURS.muted), ...served];
  });
  const create = CREATE_ROW(dialog);
  const typed = dialog.title.trim() !== "";
  return [
    [span("Projects", COLOURS.text, true), span("  this folder's agent serves every ticked project", COLOURS.dim)],
    ...rows,
    [marker(create), span("+ ", typed ? COLOURS.text : COLOURS.dim), span("Create a new project:", typed ? COLOURS.text : COLOURS.muted), span("  "), titleField(dialog, dialog.row === create)],
    [],
  ];
}

/** The instances as radio rows: name, address and version in columns; one too old for this command is dimmed and says so. */
function instanceRows(instances: InstanceEntry[], focused: number): Span[][] {
  const names = Math.max(...instances.map((entry) => [...entry.name].length)) + 1;
  const addresses = Math.max(...instances.map((entry) => [...addressText(entry.serverUrl)].length)) + 3;
  return instances.map((entry, index) => {
    const row = [span(addressText(entry.serverUrl).padEnd(addresses), entry.tooOld ? COLOURS.dim : COLOURS.muted), span(entry.version ? `v${entry.version}` : "", entry.tooOld ? COLOURS.dim : COLOURS.muted), ...(entry.tooOld ? [span(" · too old for this command", COLOURS.dim)] : [])];
    const label = [span(entry.name.padEnd(names), entry.tooOld ? COLOURS.dim : index === focused ? COLOURS.text : COLOURS.text, index === focused && !entry.tooOld), ...row];
    return radioRow(label, index === focused, index === focused);
  });
}

/** `?`: the keys, then the commands (board `aide.html`). */
function helpBox(): DialogBox {
  const key = (name: string) => span(name, COLOURS.text, true);
  const row = (...spans: Span[]): Row => ({ spans });
  const body: Row[] = [
    row(span("KEYS", COLOURS.muted, true)),
    row(key("Tab"), span(" next tab · ", COLOURS.muted), key("1 2 3"), span(" Agents, Instances, Comments · ", COLOURS.muted), key("↑↓"), span(" move or scroll · ", COLOURS.muted), key("← →"), span(" left pane / list", COLOURS.muted)),
    row(),
    row(span("COMMANDS", COLOURS.muted, true)),
    ...COMMANDS.flatMap(({ command, description, options }) => [row(span(commandCell(command), COLOURS.text), span(description, COLOURS.muted)), ...(options ? [row(span(`        ${options}`, COLOURS.muted))] : [])]),
  ];
  return { width: 102, row: TOP_ROW, rows: (inner) => dialogFrame([span("Commands", COLOURS.text, true)], body, [{ key: "Esc", label: "close" }], inner) };
}

/** `l` with several instances: which one the folder is linked to. */
function linkBox(state: ScreenState, dialog: Extract<Dialog, { type: "link" }>): DialogBox {
  const body: Row[] = [{ spans: [span(folderLabel(state.folder, state.home), COLOURS.muted), span("  isn't linked to an instance yet.", COLOURS.dim)] }, { spans: [] }, { spans: [span("Instance", COLOURS.text, true)] }, ...instanceRows(state.instances, dialog.row).map((spans) => ({ spans })), { spans: [] }, { spans: [span("No project and no agent yet: redline agent picks one.", COLOURS.dim)] }];
  return { width: 82, top: 0.35, rows: (inner) => dialogFrame([span("Link this folder", COLOURS.text, true)], body, [{ key: "↑↓", label: "choose" }, { key: "Enter", label: "link" }, { key: "Esc", label: "cancel" }], inner) };
}

function newBox(state: ScreenState, dialog: NewAgentDialog): DialogBox {
  const where = folderLabel(state.folder, state.home);
  const body: Span[][] = [];
  const keys: BarItem[] = [{ key: "Esc", label: "cancel" }];
  const known = dialog.stage !== "loading" || dialog.serverUrl !== undefined || dialog.error !== undefined;
  const notLinked = state.folderLine.kind === "linked" ? "project" : "instance";
  body.push(dialog.linkedTitles ? [span(where, COLOURS.muted), span(`  serves ${dialog.linkedTitles.join(", ")}.`, COLOURS.dim)] : known ? [span(where, COLOURS.muted), span(`  isn't linked to an ${notLinked} yet.`.replace("an project", "a project"), COLOURS.dim)] : [span(where, COLOURS.muted)], []);
  if (dialog.stage === "loading" && !dialog.error) body.push([span("Checking this folder…", COLOURS.dim)]);
  if (dialog.stage === "instance") {
    body.push([span("Instance", COLOURS.text, true)], ...instanceRows(dialog.instances, dialog.instanceRow));
    const focused = dialog.instances[dialog.instanceRow];
    body.push([], [span("Project", COLOURS.text, true), span(`  on ${focused.name}, after the instance`, COLOURS.dim)]);
    keys.unshift({ key: "↑↓", label: "choose" }, { key: "Enter", label: "next" });
  }
  if (dialog.stage === "form") {
    const model = MODEL_ROW(dialog);
    if (dialog.linkedTitles) body.push(...tickRows(dialog));
    else {
      const on = dialog.instances.length > 1 ? state.instances.find((entry) => entry.serverUrl === dialog.serverUrl) : undefined;
      body.push([span("Project", COLOURS.text, true), ...(on ? [span(`  on ${on.name}`, COLOURS.dim)] : [])]);
      dialog.projects.forEach((project, index) => body.push(radioRow([span(project.title, dialog.picked === index ? COLOURS.text : COLOURS.muted)], dialog.row === index, dialog.picked === index)));
      const create = CREATE_ROW(dialog);
      const focused = dialog.row === create;
      body.push(radioRow([span("Create a new project:", dialog.picked === create ? COLOURS.text : COLOURS.muted), span("  "), titleField(dialog, focused)], focused, dialog.picked === create), []);
    }
    const models = modelOptions(dialog.model);
    const efforts = EFFORT_OPTIONS.map((effort) => effort ?? "default");
    body.push(choiceRow("Model", dialog.row <= model, models, models.indexOf(dialog.model)), choiceRow("Effort", dialog.row === model + 1, efforts, EFFORT_OPTIONS.indexOf(dialog.effort)), []);
    body.push(dialog.busy ? [span("Starting…", COLOURS.dim)] : [span("Last choice for this folder is preselected.", COLOURS.dim)]);
    keys.unshift({ key: "↑↓", label: "field" }, ...(dialog.linkedTitles && dialog.row < CREATE_ROW(dialog) ? [{ key: "Space", label: "tick" }] : []), { key: "←→", label: "choice" }, { key: "Enter", label: "start" });
  }
  if (dialog.error) body.push([], [span("✗ ", COLOURS.red), span(dialog.error, COLOURS.muted)]);
  return { width: 82, top: 0.35, rows: (inner) => dialogFrame([span("New agent", COLOURS.text, true), span("  in the current folder", COLOURS.muted)], body.map((spans) => ({ spans })), keys, inner) };
}

function dialogBox(state: ScreenState, dialog: Dialog): DialogBox | undefined {
  if (dialog.type === "new") return newBox(state, dialog);
  if (dialog.type === "help") return helpBox();
  if (dialog.type === "link") return linkBox(state, dialog);
  const agent = state.agents.find((a) => a.id === dialog.agentId);
  if (!agent) return undefined;
  return dialog.type === "stop" ? stopBox(state, agent) : modelBox(state, agent, dialog);
}

/** The whole screen: exactly `rows` lines of `columns` cells, with ANSI colours (24-bit) and background. */
export function render(state: ScreenState, { columns, rows }: Size): string[] {
  const rightCells = Math.min(RIGHT_WIDTH, Math.floor(columns * 0.4));
  const leftCells = Math.max(1, columns - rightCells - 1);
  const bodyHeight = Math.max(0, rows - CHROME_ROWS);
  const { left, right } = TABS[state.tab].body(state, { left: leftCells, right: rightCells, height: bodyHeight });
  const rule = (cells: number) => span("─".repeat(cells), COLOURS.rule);
  const out: Span[][] = [];

  // A blank row above the header, so the title does not touch the terminal's tab bar.
  out.push(fit([], columns));
  out.push(fit(headerRow(state, columns).spans, columns));
  out.push(fit(folderRow(state).spans, columns));
  out.push(fit([], columns));
  out.push(fit(tabRow(state).spans, columns));
  out.push([span("─".repeat(leftCells), COLOURS.rule), span("┬", COLOURS.rule), rule(rightCells)]);
  for (let i = 0; i < bodyHeight; i++) {
    const l = left[i] ?? { spans: [] };
    const r = right[i] ?? { spans: [] };
    const joint = l.rule && r.rule ? "┼" : l.rule ? "┤" : r.rule ? "├" : "│";
    const side = (row: Row, cells: number) => (row.rule ? [rule(cells)] : fit(row.spans, cells));
    out.push([...side(l, leftCells), span(joint, COLOURS.rule), ...side(r, rightCells)]);
  }
  out.push([span("─".repeat(leftCells), COLOURS.rule), span("┴", COLOURS.rule), rule(rightCells)]);
  out.push(barRow(state, columns));
  const frame = out.slice(0, rows);

  const asked = state.dialog && dialogBox(state, state.dialog);
  if (!asked) return frame.map((line) => toAnsi(line));
  const { width: wanted, rows: boxRows, top: topShare = 0.4, row } = asked;
  const boxWidth = Math.min(wanted, columns - 4);
  const box = boxRows(boxWidth - 2);
  const top = row ?? Math.max(1, Math.floor((rows - box.length) * topShare));
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
    lines.push(toAnsi([span("  "), span(`${dot(agent)} `, STATE_COLOR[agent.state]), span(agent.name.padEnd(nameWidth), stopped ? COLOURS.dim : COLOURS.text), span(activityLabel(agent, state.logs[agent.id] ?? []), stopped ? COLOURS.dim : COLOURS.muted)], false));
  }
  lines.push(toAnsi([span("Run ", COLOURS.muted), span("redline agents", COLOURS.text, true), span(" to see them again.", COLOURS.muted)], false));
  return lines;
}
