import { cellText, instanceStateLabel, renderingLabel, type InstanceState, type Thread, type ThreadRendering, type TweakValues } from "@redline/shared";
import { canvasElementText } from "./canvas-element-text.js";

/** "element `selector` (named « bouton « Continuer » »)": the exact selector, plus the readable name when the bridge computed one. */
export function elementText(target: { selector: string; elementName?: string | null }): string {
  return `element \`${target.selector}\`${target.elementName ? ` (named « ${target.elementName} »)` : ""}`;
}

/** " (vu en Mobile · 390 px)" for something seen in a rendering of a responsive artboard; `explain` adds what it means for a comment. */
export function renderingText(rendering: ThreadRendering | undefined, explain = false): string {
  if (!rendering) return "";
  return ` (vu en ${renderingLabel(rendering)} px${explain ? ": the user commented the page laid out at that width, so fix that breakpoint" : ""})`;
}

/** " (vu en Hover · Outlined · icon off)" for something seen in a cell of a tweak grid; `explain` adds what it means for a comment. */
export function cellSeenText(cell: TweakValues | undefined, explain = false): string {
  if (!cell) return "";
  return ` (vu en ${cellText(cell)}${explain ? ": the user commented that combination of tweak values, shown with those values applied" : ""})`;
}

/** " (vu avec confirm ouverte)" for something seen while component instances were in a state of their own; `explain` adds what it means for a comment. */
export function instanceStateSeenText(state: InstanceState[] | undefined, explain = false): string {
  if (!state) return "";
  return ` (vu avec ${instanceStateLabel(state)}${explain ? ": the user commented with those component instances in that state (attributes set on them), so the element may only exist or show in that state" : ""})`;
}

/** Where a thread points, as Claude is told: the artboard and element with position, the whole artboard, or a canvas element. */
export function threadSubject(thread: Thread): string {
  if (thread.target.kind === "canvas-element") return `on ${canvasElementText(thread.target, thread.removed)}`;
  if (thread.target.kind === "artboard") return `on the whole artboard ${thread.artboard} (no specific element)`;
  return `on artboard ${thread.artboard}${renderingText(thread.rendering, true)}${cellSeenText(thread.cell, true)}${instanceStateSeenText(thread.instanceState, true)}, ${elementText(thread)} (position ${thread.xPct}% / ${thread.yPct}% of the artboard)`;
}
