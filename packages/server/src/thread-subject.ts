import { cellText, describeZone, instanceStateLabel, renderingLabel, sandboxTrialText, type InstanceState, type SandboxTrial, type Thread, type ThreadRendering, type TweakValues } from "@redline/shared";
import { canvasElementText } from "./canvas-element-text.js";

/** A line of the conversation so far, for a session that starts afresh: "User: …", "Redline: …" or "Claude: …". */
export const replyLine = (reply: { author: "claude" | "user" | "redline"; body: string }): string =>
  `${reply.author === "user" ? "User" : reply.author === "redline" ? "Redline" : "Claude"}: ${reply.body}`;

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

/** " (vu en bac à sable : secondary · lg, slot default « Publier »)" for something seen in a component's sandbox; `explain` adds what it means. */
export function sandboxSeenText(trial: SandboxTrial | undefined, explain = false): string {
  if (!trial) return "";
  const text = sandboxTrialText(trial);
  return ` (vu en bac à sable${text ? ` : ${text}` : ""}${explain ? ": the user commented a lone instance of this component tried in the sandbox beside its artboard, with those settings, states and slot texts; the element is inside that instance, not in the artboard's own markup, so fix the component (its template, style or script)" : ""})`;
}

/** " (vu avec confirm ouverte)" for something seen while component instances were in a state of their own; `explain` adds what it means for a comment. */
export function instanceStateSeenText(state: InstanceState[] | undefined, explain = false): string {
  if (!state) return "";
  return ` (vu avec ${instanceStateLabel(state)}${explain ? ": the user commented with those component instances in that state (attributes set on them), so the element may only exist or show in that state" : ""})`;
}

/** "the zone x 64 % · y 18 % · 28 % × 26 % de l'artboard list.html (vu en Mobile)": a rectangle a reviewer drew. */
export function zoneSubject(target: Extract<Thread["target"], { kind: "zone" }>): string {
  const { kind: _kind, ...rect } = target;
  return target.space === "artboard" ? `the ${describeZone(rect)} ${target.artboard}${renderingText(target.rendering, true)}${cellSeenText(target.cell, true)}` : `the ${describeZone(rect)}`;
}

/** Where a thread points, as Claude is told: the artboard and element with position, the whole artboard, or a canvas element. */
export function threadSubject(thread: Thread): string {
  if (thread.target.kind === "canvas-element") return `on ${canvasElementText(thread.target, thread.removed)}`;
  if (thread.target.kind === "zone") return `on ${zoneSubject(thread.target)}`;
  if (thread.target.kind === "artboard") return `on the whole artboard ${thread.artboard} (no specific element)`;
  if (thread.sandbox) return `on artboard ${thread.artboard}${sandboxSeenText(thread.sandbox, true)}, ${elementText(thread)}`;
  return `on artboard ${thread.artboard}${renderingText(thread.rendering, true)}${cellSeenText(thread.cell, true)}${instanceStateSeenText(thread.instanceState, true)}, ${elementText(thread)} (position ${thread.xPct}% / ${thread.yPct}% of the artboard)`;
}
