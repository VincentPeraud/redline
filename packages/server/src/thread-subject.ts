import { renderingLabel, type Thread } from "@redline/shared";

/** "element `selector` (the user calls it « bouton « Continuer » »)": the exact selector, plus the readable name when the bridge computed one. */
function elementText(thread: Pick<Thread, "selector" | "elementName">): string {
  return `element \`${thread.selector}\`${thread.elementName ? ` (named « ${thread.elementName} »)` : ""}`;
}

/** " (vu en Mobile · 390 px: the user commented the page laid out at that width, so fix that breakpoint)" for a thread pinned in a rendering of a responsive artboard. */
function renderingText(thread: Pick<Thread, "rendering">): string {
  return thread.rendering ? ` (vu en ${renderingLabel(thread.rendering)} px: the user commented the page laid out at that width, so fix that breakpoint)` : "";
}

/** Where a thread points, as Claude is told: the artboard and element with position, or the whole artboard. */
export function threadSubject(thread: Thread): string {
  if (thread.target.kind === "artboard") return `on the whole artboard ${thread.artboard} (no specific element)`;
  return `on artboard ${thread.artboard}${renderingText(thread)}, ${elementText(thread)} (position ${thread.xPct}% / ${thread.yPct}% of the artboard)`;
}
