import type { TerminalCommentsPage } from "@redline/shared";
import { C, MARGIN, clock, clip, listWindow, ruleRow, span, spaces, addressText, type BarItem, type Key, type Row, type ScreenState, type Span, type Update } from "./agents-view.js";

/** One page of one instance with comments waiting for a terminal session. */
export interface CommentsEntry {
  instanceId: string;
  instance: string;
  serverUrl: string;
  page: TerminalCommentsPage;
}

/** An instance whose waiting comments could not be read. */
export interface CommentsFailure {
  instance: string;
  message: string;
}

export interface CommentsState {
  status: "loading" | "loaded";
  entries: CommentsEntry[];
  failures: CommentsFailure[];
  selected: number;
  /** Lines the selected page's comments are scrolled down from their top. */
  scroll: number;
}

export const initialComments: CommentsState = { status: "loading", entries: [], failures: [], selected: 0, scroll: 0 };

/** What the load found: the selection stays on the same page when it is still there. */
export function commentsLoaded(state: ScreenState, { entries, failures }: { entries: CommentsEntry[]; failures: CommentsFailure[] }): ScreenState {
  const kept = selectedEntry(state.comments);
  const index = kept ? entries.findIndex((entry) => entry.serverUrl === kept.serverUrl && entry.page.pageId === kept.page.pageId) : -1;
  return { ...state, comments: { status: "loaded", entries, failures, selected: index >= 0 ? index : 0, scroll: index >= 0 ? state.comments.scroll : 0 } };
}

const selectedEntry = (comments: CommentsState): CommentsEntry | undefined => comments.entries[comments.selected];

// Function declarations: agents-view imports this module and this one imports it back, so only hoisted names are safe at load time.
export function commentsCount(state: ScreenState): number {
  return state.comments.entries.reduce((total, entry) => total + entry.page.comments.length, 0);
}

export function commentsHeaderInstance(state: ScreenState): string | undefined {
  const entry = selectedEntry(state.comments);
  return entry && `${entry.instance} · ${addressText(entry.serverUrl)}`;
}

export function commentsBar(state: ScreenState): BarItem[] {
  const move = { key: "↑↓", label: state.focus === "detail" ? "scroll" : "page" };
  return selectedEntry(state.comments) ? [move, { key: "←→", label: "comments/list" }, { key: "o", label: "open in Redline" }] : [];
}

export function commentsOnKey(state: ScreenState, key: Key): Update {
  const { comments } = state;
  const entry = selectedEntry(comments);
  if (!entry) return { state, commands: [] };
  if (key === "o") return { state, commands: [{ type: "open", url: `${entry.serverUrl.replace(/\/+$/, "")}/#/pages/${entry.page.pageId}` }] };
  if (key !== "up" && key !== "down") return { state, commands: [] };
  const step = key === "down" ? 1 : -1;
  if (state.focus === "detail") return { state: { ...state, comments: { ...comments, scroll: Math.max(0, comments.scroll + step) } }, commands: [] };
  const selected = Math.min(comments.entries.length - 1, Math.max(0, comments.selected + step));
  return { state: { ...state, comments: { ...comments, selected, scroll: 0 } }, commands: [] };
}

export function commentsBody(state: ScreenState, { left, right, height }: { left: number; right: number; height: number }): { left: Row[]; right: Row[] } {
  return { left: detailPane(state, left, height), right: listPane(state, right, height) };
}

const note = (text: string): Row => ({ spans: [span(`${spaces(MARGIN)}${text}`, C.muted)] });

function listPane(state: ScreenState, cells: number, height: number): Row[] {
  const { entries, failures, selected } = state.comments;
  const failed = failures.map((failure) => ({ spans: [span(`${spaces(MARGIN)}${failure.instance}: ${failure.message}`, C.amber)] }));
  if (entries.length === 0) return [...(failures.length > 0 ? [{ spans: [] }] : []), ...failed];
  const { first, shown } = listWindow(entries.length, selected, height - failures.length);
  const hidden = (text: string): Row => ({ spans: [span(`${spaces(MARGIN)}${text}`, C.dim)] });
  const rows: Row[] = [first > 0 ? hidden(`↑ ${first} more`) : { spans: [span(`${spaces(MARGIN)}waiting for a terminal session`, C.dim)] }];
  const marker = state.focus === "list" ? C.red : C.dim;
  entries.slice(first, first + shown).forEach((entry, offset) => {
    const isSelected = first + offset === selected;
    const bg = isSelected ? C.selected : undefined;
    const bar = span(isSelected ? "▎" : " ", marker, false, bg);
    const title = [bar, span(" ", C.text, false, bg), isSelected ? span("› ", marker, true, bg) : span("  ", C.text, false, bg), span(`${entry.page.comments.length} `, C.amber, false, bg), ...clip([span(entry.page.title, C.text, true, bg)], cells - 8)];
    const place = [bar, span(" ", C.text, false, bg), ...clip([span(`${spaces(6)}${entry.page.projectTitle}`, C.dim, false, bg)], cells - 2)];
    rows.push({ spans: fill(title, cells, bg) }, { spans: fill(place, cells, bg) }, { spans: [] });
  });
  const below = entries.length - first - shown;
  if (below > 0) rows.push(hidden(`↓ ${below} more`));
  return [...rows, ...failed];
}

/** Pads with the background so that the selected row is a full band. */
function fill(spans: Span[], cells: number, bg?: string): Span[] {
  const used = spans.reduce((total, s) => total + [...s.text].length, 0);
  return [...spans, { text: spaces(cells - used), bg }];
}

function detailPane(state: ScreenState, cells: number, height: number): Row[] {
  const { status, scroll } = state.comments;
  const entry = selectedEntry(state.comments);
  if (!entry) return [{ spans: [] }, note(status === "loading" ? "Loading the comments…" : "No comment is waiting for a terminal session.")];
  const { page } = entry;
  const holder = page.holder
    ? [span("the Claude Code session in ", C.text), span(page.holder.folder, C.text), span(` (published ${clock(page.holder.since, false)})`, C.text)]
    : [span("no terminal session is present", C.muted)];
  const focused = state.focus === "detail";
  const count = page.comments.length;
  const head: Row[] = [
    { spans: [] },
    { spans: [span(spaces(MARGIN)), span(page.title, C.text, true), span(`  ${page.projectTitle}`, C.muted), span(" on ", C.dim), span(entry.instance, C.muted)] },
    { spans: [span(spaces(MARGIN)), span("Held by    ", C.dim), ...holder] },
    ruleRow(),
    { spans: [span(focused ? "▎" : " ", C.red), span(" "), span(`${count} ${count === 1 ? "COMMENT" : "COMMENTS"}`, C.text, true), span(focused ? "  focused: ↑↓ scroll, → back to the list" : "  ← to scroll them", C.dim)] },
  ];
  const lines = page.comments.flatMap((comment, index): Row[] => [
    ...(index > 0 ? [{ spans: [] }] : []),
    { spans: [span(spaces(MARGIN)), span(comment.author, C.text, true), span(`  ${clock(comment.at, false)} · ${comment.target}`, C.dim)] },
    ...wrap(`« ${comment.text} »`, cells - MARGIN).map((line): Row => ({ spans: [span(spaces(MARGIN)), span(line, C.muted)] })),
  ]);
  const hint: Row[] = [
    ruleRow(),
    { spans: [span(spaces(MARGIN)), span("In that session, ask Claude: ", C.dim), span("traite mes commentaires", C.text, true)] },
    { spans: [span(spaces(MARGIN)), span("o", C.text, true), span(" opens the page in Redline.", C.dim)] },
  ];
  const room = Math.max(0, height - head.length - hint.length);
  if (lines.length <= room) return [...head, ...lines, ...hint];
  const start = Math.min(scroll, lines.length - room);
  return [...head, ...lines.slice(start, start + room), ...hint];
}

/** Breaks a text into lines of at most `limit` cells, at spaces, keeping its own line breaks. */
function wrap(text: string, limit: number): string[] {
  return text.split("\n").flatMap((paragraph) => {
    const out: string[] = [];
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if ([...next].length > limit && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    return [...out, line];
  });
}
