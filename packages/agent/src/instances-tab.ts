import { COLOURS, span, width, spaces, clip, fit, ruleRow, wrap, MARGIN, DETAIL_LABEL_WIDTH, plural, folderLabel, addressText, type Span, type Row, type BarItem, type TabBody } from "./terminal-draw.js";
import type { ScreenState, Update } from "./agents-view.js";
import type { InstanceDetails } from "./instance-details.js";
import type { InstanceEntry } from "./instance-list.js";

/**
 * The Instances tab: the installations, problems first, on the right; doctor for the selected one on the left. Pure functions like
 * the rest of the screen: `onKey` (through `TABS`) and `render` read and write `ScreenState.instancesTab`; the runner loads the details
 * (`inspect-instance`), runs `update-instance` / `remove-instance`, and reports back with `instanceInspected` and `instanceActionDone`.
 */
export interface InstancesTabState {
  /** The installation selected; the first of the list when none (or one that is gone). */
  selectedId?: string;
  /** Each installation's diagnosis; absent while it is being gathered. */
  details: Record<string, InstanceDetails>;
  /** Lines the detail pane is scrolled down. */
  scroll: number;
  /** An update or a removal in progress: the keys wait for it. */
  busy?: { id: string; action: "update" | "remove" };
  /** What the last update or removal said, until the selection moves. */
  result?: { ok: boolean; lines: string[] };
  /** `s` closed the screen to run the setup: the command asks for it after the screen. */
  setupAfter?: boolean;
}

export const initialInstancesTab = (): InstancesTabState => ({ details: {}, scroll: 0 });

export interface InstanceAction {
  ok: boolean;
  lines: string[];
  /** The installation was removed. */
  removed?: boolean;
  /** The version now installed, after an update. */
  version?: string;
}

// ---- Order and counts -----------------------------------------------------------------------------------------

/** Problems first: an update available, too old, a refused token, unreachable; then the up to date ones, the unknown ones last among them. */
const RANK = { "update-available": 0, "too-old": 1, "token-refused": 2, unreachable: 3, "up-to-date": 4 } as const;
const LOADING_RANK = 4;

const rankOf = (state: ScreenState, entry: InstanceEntry): number => {
  const loaded = state.instancesTab.details[entry.id];
  return loaded ? RANK[loaded.diagnosis.state] : LOADING_RANK;
};

/** The installations in the order the list shows them (stable within a rank). */
export const sortedInstances = (state: ScreenState): InstanceEntry[] =>
  state.instances.map((entry, index) => ({ entry, index })).sort((a, b) => rankOf(state, a.entry) - rankOf(state, b.entry) || a.index - b.index).map(({ entry }) => entry);

export function selectedInstance(state: ScreenState): InstanceEntry | undefined {
  const sorted = sortedInstances(state);
  return sorted.find((entry) => entry.id === state.instancesTab.selectedId) ?? sorted[0];
}

/** The "! n" of the tab: what doctor finds wrong, with the count the caller gave for those not diagnosed yet. */
export const instancesProblems = (state: ScreenState): number =>
  state.instances.reduce((total, entry) => {
    const loaded = state.instancesTab.details[entry.id];
    return total + (loaded ? (loaded.diagnosis.severity === "ok" ? 0 : 1) : (entry.problems ?? 0));
  }, 0);

export const instancesHeaderInstance = (state: ScreenState): string | undefined => {
  const entry = selectedInstance(state);
  return entry ? `${entry.name} · ${addressText(entry.serverUrl)}` : undefined;
};

export function instancesSummary(state: ScreenState): Span[] {
  const problems = instancesProblems(state);
  return [span(plural(state.instances.length, "instance"), COLOURS.muted), span(" · ", COLOURS.dim), problems > 0 ? span(plural(problems, "problem"), COLOURS.amber) : span("no problem", COLOURS.dim)];
}

export const instancesBar = (state: ScreenState): BarItem[] => [
  { key: "↑↓", label: "instance" },
  ...(selectedInstance(state) ? [{ key: "u", label: "update" }, { key: "x", label: "remove" }] : []),
  { key: "s", label: "setup another" },
];

// ---- Events ---------------------------------------------------------------------------------------------------

/** The diagnosis of an installation arrived. */
export const instanceInspected = (state: ScreenState, id: string, details: InstanceDetails): ScreenState => ({
  ...state,
  instancesTab: { ...state.instancesTab, details: { ...state.instancesTab.details, [id]: details } },
  instances: state.instances.map((entry) => (entry.id === id ? { ...entry, version: details.installedVersion ?? entry.version } : entry)),
});

/** An update or a removal ended: what it said is shown; an updated installation is checked again, a removed one leaves the list. */
export function instanceActionDone(state: ScreenState, id: string, action: InstanceAction): ScreenState {
  const { [id]: gone, ...kept } = state.instancesTab.details;
  const result = { ok: action.ok, lines: action.lines };
  if (action.removed) {
    const sorted = sortedInstances(state);
    const index = sorted.findIndex((entry) => entry.id === id);
    const next = (sorted[index + 1] ?? sorted[index - 1])?.id;
    return { ...state, instances: state.instances.filter((entry) => entry.id !== id), instancesTab: { ...state.instancesTab, details: kept, selectedId: next, scroll: 0, busy: undefined, result } };
  }
  const refreshed = action.ok;
  return {
    ...state,
    instances: refreshed ? state.instances.map((entry) => (entry.id === id ? { ...entry, version: action.version ?? entry.version } : entry)) : state.instances,
    instancesTab: { ...state.instancesTab, details: refreshed ? kept : state.instancesTab.details, busy: undefined, result },
  };
}

// ---- Keys -----------------------------------------------------------------------------------------------------

export function instancesOnKey(state: ScreenState, key: string): Update {
  const tab = state.instancesTab;
  const selected = selectedInstance(state);
  if (key === "s") return { state: { ...state, instancesTab: { ...tab, setupAfter: true } }, commands: [{ type: "close" }] };
  if (key === "up" || key === "down") {
    if (state.focus === "detail") {
      const last = selected ? Math.max(0, leftRows(state, selected, UNWRAPPED).length - 1) : 0;
      return { state: { ...state, instancesTab: { ...tab, scroll: Math.min(last, Math.max(0, tab.scroll + (key === "up" ? -1 : 1))) } }, commands: [] };
    }
    const sorted = sortedInstances(state);
    const index = selected ? sorted.indexOf(selected) : 0;
    const next = sorted[Math.min(sorted.length - 1, Math.max(0, index + (key === "up" ? -1 : 1)))];
    return { state: next ? { ...state, instancesTab: { ...tab, selectedId: next.id, scroll: 0, result: undefined } } : state, commands: [] };
  }
  const ready = selected && state.instancesTab.details[selected.id] && !tab.busy;
  if (ready && key === "u") return { state: { ...state, instancesTab: { ...tab, busy: { id: selected.id, action: "update" }, result: undefined } }, commands: [{ type: "update-instance", id: selected.id }] };
  if (ready && key === "x") return { state: { ...state, instancesTab: { ...tab, busy: { id: selected.id, action: "remove" }, result: undefined } }, commands: [{ type: "remove-instance", id: selected.id }] };
  return { state, commands: [] };
}

// ---- Rendering ------------------------------------------------------------------------------------------------

const ITEM_ROWS = 2;
/** A pane wide enough that nothing wraps, to count the lines a key can scroll to. */
const UNWRAPPED = 1000;

/** The items that fit `height` rows below a first row kept for "↑ n more"; the last row of the list is "↓ n more" when some are left. */
function window(total: number, selected: number, height: number): { first: number; shown: number } {
  const room = Math.max(0, height - 1);
  const fits = Math.max(1, Math.floor(room / ITEM_ROWS));
  if (total <= fits) return { first: 0, shown: total };
  const shown = Math.max(1, Math.floor((room - 1) / ITEM_ROWS));
  return { first: Math.max(0, Math.min(selected - 1, total - shown)), shown };
}

/** The icon, the short state and their colours, as the list and the detail title say them. */
function badge(loaded: InstanceDetails | undefined): { icon: string; iconColor: string; label: string; labelColor: string } {
  if (!loaded) return { icon: "…", iconColor: COLOURS.dim, label: "checking", labelColor: COLOURS.dim };
  switch (loaded.diagnosis.state) {
    case "update-available":
      return { icon: "!", iconColor: COLOURS.amber, label: "update available", labelColor: COLOURS.amber };
    case "too-old":
      return { icon: "✗", iconColor: COLOURS.red, label: "too old", labelColor: COLOURS.redText };
    case "token-refused":
      return { icon: "✗", iconColor: COLOURS.red, label: "token refused", labelColor: COLOURS.redText };
    case "unreachable":
      return { icon: "✗", iconColor: COLOURS.red, label: "unreachable", labelColor: COLOURS.redText };
    case "up-to-date":
      return { icon: "✓", iconColor: COLOURS.green, label: "up to date", labelColor: COLOURS.dim };
  }
}

function listRows(state: ScreenState, cells: number, height: number): Row[] {
  const sorted = sortedInstances(state);
  if (sorted.length === 0) return [];
  const selected = selectedInstance(state);
  const { first, shown } = window(sorted.length, selected ? sorted.indexOf(selected) : 0, height);
  const below = sorted.length - first - shown;
  const more = (text: string): Row => ({ spans: [span(`${spaces(MARGIN)}${text}`, COLOURS.dim)] });
  const rows: Row[] = [first > 0 ? more(`↑ ${first} more`) : more("problems first")];
  const nameWidth = Math.max(10, ...sorted.map((entry) => [...entry.name].length + 2));
  const versionWidth = Math.max(...sorted.map((entry) => [...`v${entry.version ?? "?"}`].length)) + 2;
  const marker = state.focus === "list" ? COLOURS.red : COLOURS.dim;
  for (const entry of sorted.slice(first, first + shown)) {
    const isSelected = entry === selected;
    const bg = isSelected ? COLOURS.selected : undefined;
    const { icon, iconColor, label, labelColor } = badge(state.instancesTab.details[entry.id]);
    const name = clip([span(entry.name)], nameWidth).map((s) => s.text).join("").padEnd(nameWidth);
    rows.push({
      spans: fit(
        [
          span(isSelected ? "▎" : " ", marker, false, bg),
          span(" ", COLOURS.text, false, bg),
          isSelected ? span("› ", marker, true, bg) : span("  ", COLOURS.text, false, bg),
          span(`${icon} `, iconColor, false, bg),
          span(name, COLOURS.text, true, bg),
          span(`v${entry.version ?? "?"}`.padEnd(versionWidth), COLOURS.muted, false, bg),
          span(label, labelColor, false, bg),
        ],
        cells,
        bg,
      ),
    });
    rows.push({ spans: [] });
  }
  if (below > 0) rows.push(more(`↓ ${below} more`));
  return rows;
}

/** The board leaves this many cells between the state and the pane's edge. */
const STATUS_MARGIN = 5;

const blank: Row = { spans: [] };

/** Cut at `cells` minus the margins: a text wraps instead of being cut. */
const wrapped = (text: string, cells: number, indent = ""): string[] => wrap(text, Math.max(1, cells - 2 * MARGIN - indent.length));

function fieldRows(label: string, value: string, color: string, cells: number): Row[] {
  const lines = wrapped(value, cells, " ".repeat(DETAIL_LABEL_WIDTH));
  return lines.map((line, index) => ({ spans: [span(spaces(MARGIN)), span(index === 0 ? label.padEnd(DETAIL_LABEL_WIDTH) : spaces(DETAIL_LABEL_WIDTH), COLOURS.dim), span(line, color)] }));
}

/** A paragraph that starts with a bold key: `u installs v0.2.1...`; its lines wrap at the pane's width. */
function keyParagraph(key: string, text: string, color: string, cells: number): Row[] {
  return wrapped(`${key} ${text}`, cells).map((line, index) => ({ spans: [span(spaces(MARGIN)), ...(index === 0 ? [span(key, COLOURS.text, true), span(line.slice(key.length), color)] : [span(line, color)])] }));
}

const sentence = (names: string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What `u` does to this installation: its new version, its agents, the sessions that must reconnect. */
function updateText(loaded: InstanceDetails): string {
  const { agents, sessions } = loaded;
  const installs = `installs ${loaded.serverVersion ? `v${loaded.serverVersion}` : "the server's build"}.`;
  const restarts = agents.length > 0 ? `${sentence(agents)} restart${agents.length === 1 ? "s" : ""}, each after its run` : "";
  const reconnect = sessions > 0 ? `the ${sessions === 1 ? "session then needs" : `${sessions} sessions then need`} /mcp and reconnect redline.` : "";
  if (restarts && reconnect) return `${installs} ${restarts}; ${reconnect}`;
  if (restarts) return `${installs} ${restarts}.`;
  return reconnect ? `${installs} ${reconnect[0].toUpperCase()}${reconnect.slice(1)}` : installs;
}

function resultRows(state: ScreenState, entry: InstanceEntry, cells: number): Row[] {
  const { busy, result } = state.instancesTab;
  if (busy) return [blank, { spans: [span(spaces(MARGIN)), span(`${busy.action === "update" ? "Updating" : "Removing"} ${entry.name}...`, COLOURS.muted)] }];
  if (!result) return [];
  const rows = result.lines.flatMap((text, index) =>
    wrapped(text, cells, "  ").map((line, position): Row => {
      const mark = result.ok ? (line.startsWith("✓ ") ? "✓ " : "") : index === 0 && position === 0 ? "✗ " : "";
      const body = line.startsWith("✓ ") && result.ok ? line.slice(2) : line;
      const indent = !mark && !result.ok ? "  " : "";
      return { spans: [span(spaces(MARGIN)), ...(mark ? [span(mark, result.ok ? COLOURS.green : COLOURS.red)] : [span(indent)]), span(body, result.ok ? COLOURS.muted : COLOURS.redText)] };
    }),
  );
  return [blank, ...rows];
}

/** The detail pane: doctor for the installation, then what to do, then what the last action said. */
function leftRows(state: ScreenState, entry: InstanceEntry, cells: number): Row[] {
  const loaded = state.instancesTab.details[entry.id];
  const { icon, iconColor, label, labelColor } = badge(loaded);
  const head = [span(entry.name, COLOURS.text, true), span("  "), span(addressText(entry.serverUrl), COLOURS.muted)];
  const status = [span(`${icon} ${label}`, loaded?.diagnosis.severity === "problem" ? COLOURS.redText : labelColor)];
  const rows: Row[] = [blank, { spans: [span(spaces(MARGIN)), ...head, span(spaces(cells - MARGIN - STATUS_MARGIN - width(head) - width(status))), ...status] }];
  if (!loaded) {
    rows.push(...fieldRows("Installed", `v${entry.version ?? "?"}`, COLOURS.text, cells), blank, { spans: [span(spaces(MARGIN)), span("Checking the server and what uses this installation...", COLOURS.dim)] }, ...resultRows(state, entry, cells));
    return rows;
  }
  const { diagnosis } = loaded;
  const token =
    diagnosis.state === "token-refused"
      ? { text: diagnosis.status.replace(/^token /, ""), color: COLOURS.redText }
      : diagnosis.state === "unreachable"
        ? { text: "not checked: the server cannot be reached", color: COLOURS.muted }
        : { text: "OK", color: COLOURS.green };
  rows.push(
    ...fieldRows("Installed", `v${loaded.installedVersion ?? "?"} · ${folderLabel(loaded.dir, state.home)}`, COLOURS.text, cells),
    ...fieldRows("Server", loaded.serverVersion ? `v${loaded.serverVersion}` : "unknown", loaded.serverVersion ? COLOURS.text : COLOURS.dim, cells),
    ...(diagnosis.state === "too-old" ? fieldRows("Status", diagnosis.status, COLOURS.redText, cells) : []),
    ...fieldRows("Token", token.text, token.color, cells),
    ...fieldRows("Agents", loaded.agents.length > 0 ? loaded.agents.join(", ") : "none", loaded.agents.length > 0 ? COLOURS.text : COLOURS.dim, cells),
    ...fieldRows("Folders", loaded.folders.length > 0 ? loaded.folders.map((folder) => folderLabel(folder, state.home)).join(", ") : "none", loaded.folders.length > 0 ? COLOURS.text : COLOURS.dim, cells),
    ...fieldRows("Sessions", loaded.sessions > 0 ? `${plural(loaded.sessions, "Claude Code session")} ${loaded.sessions === 1 ? "uses" : "use"} it` : "none", loaded.sessions > 0 ? COLOURS.text : COLOURS.dim, cells),
    ruleRow(),
  );
  const scrolling = state.focus === "detail";
  rows.push({ spans: [scrolling ? span("▎", COLOURS.red) : span(" "), span(" "), span("WHAT TO DO", COLOURS.muted, true), ...(scrolling ? [span("  ↑↓ scroll · → back to the list", COLOURS.dim)] : [])] });
  if (diagnosis.state === "update-available") rows.push(...keyParagraph("u", updateText(loaded), COLOURS.muted, cells));
  else if (diagnosis.fix) {
    const text = `→ ${diagnosis.fix.before}${diagnosis.fix.command}`;
    const lines = wrapped(text, cells);
    const at = text.length - diagnosis.fix.command.length;
    // The command is bold wherever the wrapping puts it.
    let offset = 0;
    for (const line of lines) {
      const start = text.indexOf(line, offset);
      offset = start + line.length;
      const bold = Math.max(0, at - start);
      rows.push({ spans: [span(spaces(MARGIN)), span(line.slice(0, bold), COLOURS.muted), span(line.slice(bold), COLOURS.text, true)] });
    }
  } else rows.push({ spans: [span(spaces(MARGIN)), span("Nothing to do: up to date.", COLOURS.muted)] });
  rows.push(blank, ...keyParagraph("x", "removes it (refused while an agent or a session uses it).", COLOURS.dim, cells), ...resultRows(state, entry, cells));
  return rows;
}

export function instancesBody(state: ScreenState, { left, right, height }: { left: number; right: number; height: number }): TabBody {
  const entry = selectedInstance(state);
  if (!entry) return { left: [blank, { spans: [span(`${spaces(MARGIN)}No instance is set up on this computer. Press s to set one up.`, COLOURS.muted)] }], right: [] };
  const rows = leftRows(state, entry, left);
  const offset = Math.min(state.instancesTab.scroll, Math.max(0, rows.length - height));
  return { left: rows.slice(offset), right: listRows(state, right, height) };
}
