import type { ThreadTarget } from "@redline/shared";

/** "the canvas element `note-parcours` (sticky, « Parcours… ») of manifest.json", plus " (no longer on the canvas)" for a removed element. */
export function canvasElementText(target: Extract<ThreadTarget, { kind: "canvas-element" }>, removed?: boolean): string {
  const summary = target.elementSummary ? `, ${target.elementSummary}` : "";
  return `the canvas element \`${target.elementId}\` (${target.elementKind}${summary}) of manifest.json${removed ? " (no longer on the canvas)" : ""}`;
}

/** What Claude is asked to do about a canvas element: it lives in manifest.json, not in an artboard. */
export function canvasElementTail(target: Extract<ThreadTarget, { kind: "canvas-element" }>): string {
  return `Edit the element \`${target.elementId}\` in \`manifest.json\` if the comment asks for a change, and keep its id.`;
}
