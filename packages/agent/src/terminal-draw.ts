import { sanitizeForTerminal } from "./sanitize.js";

/**
 * What the agents screen and its tabs draw with: colours, styled spans, rows, text fitting and small formatters. It knows nothing
 * of the screen's state, so the screen and every tab import it without importing each other.
 */

/** "up", "down", "ctrl-c", or the character typed. */
export type Key = string;

// ---- Cells ---------------------------------------------------------------------------------------------------

export const COLOURS = {
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
  redText: "#F87171",
};

export interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}
export interface Row {
  spans: Span[];
  /** A horizontal rule: it joins the vertical border with a tee. */
  rule?: boolean;
}

/** Every text of the screen is made here, so it is cleaned here (see `sanitizeForTerminal`). */
export const span = (text: string, fg: string = COLOURS.text, bold = false, bg?: string): Span => ({ text: sanitizeForTerminal(text), fg, bold, bg });
export const width = (spans: Span[]) => spans.reduce((total, s) => total + [...s.text].length, 0);
export const spaces = (count: number) => " ".repeat(Math.max(0, count));

/** Cuts the spans to `limit` cells, ending with an ellipsis when something was cut. */
export function clip(spans: Span[], limit: number): Span[] {
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

export function fit(spans: Span[], cells: number, bg?: string): Span[] {
  const clipped = clip(spans, cells);
  return [...clipped, { text: spaces(cells - width(clipped)), bg }];
}

const hexToSgr = (hex: string, layer: 38 | 48) => `${layer};2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;

/** `paint` draws the board's background; the shell summary leaves the terminal's own. */
export function toAnsi(spans: Span[], paint = true): string {
  return (
    spans
      .filter((s) => s.text)
      .map((s) => `\x1b[0;${[...(paint ? [hexToSgr(s.bg ?? COLOURS.bg, 48)] : []), hexToSgr(s.fg ?? COLOURS.text, 38), ...(s.bold ? ["1"] : [])].join(";")}m${s.text}`)
      .join("") + "\x1b[0m"
  );
}

/** The visible text of ANSI lines, for tests and captures. */
export const plainText = (lines: string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

export const ruleRow = (): Row => ({ spans: [], rule: true });


export const clock = (iso: string, seconds = true) => {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
};


/** Cuts a text into lines of at most `limit` characters at word boundaries (a longer word is cut). */
export function wrap(text: string, limit: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && [...current].length + 1 + [...word].length > limit) {
      out.push(current);
      current = "";
    }
    current = current ? `${current} ${word}` : word;
    while ([...current].length > limit && limit > 0) {
      out.push([...current].slice(0, limit).join(""));
      current = [...current].slice(limit).join("");
    }
  }
  return current ? [...out, current] : out;
}


export const MARGIN = 2;
/** The fields of an agent detail line up one column further than the dialog rows (boards). */
export const DETAIL_LABEL_WIDTH = 11;

export interface BarItem {
  key: string;
  label: string;
  /** The closing key is drawn with a greyer cap. */
  muted?: boolean;
}

/** The two panes of a tab's body, as rows, plus what its header says. */
export interface TabBody {
  left: Row[];
  right: Row[];
}

const ITEM_ROWS = 3;

/** The items of a list that fit `height` rows below a first row that stays free for "↑ n more": the window keeps the selection one item from its top. */
export function listWindow(total: number, selected: number, height: number): { first: number; shown: number } {
  const room = Math.max(0, height - 1);
  const fits = Math.max(1, Math.floor(room / ITEM_ROWS));
  if (total <= fits) return { first: 0, shown: total };
  // The "↓ n more" row takes the room of the last items' spacing.
  const shown = Math.max(1, Math.floor((room - 1) / ITEM_ROWS));
  return { first: Math.max(0, Math.min(selected - 1, total - shown)), shown };
}


export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
export const folderLabel = (folder: string, home: string) => (home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder);

export const addressText = (serverUrl: string) => serverUrl.replace(/^https?:\/\//, "");
/** `Lumora · redline.lumora.com · v0.2.0`: the name, the address, the version when known. */
