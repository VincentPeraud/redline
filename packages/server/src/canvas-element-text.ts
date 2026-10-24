import type { ThreadTarget } from "@redline/shared";

/** "the canvas element `note-parcours` (sticky, « Parcours… ») of manifest.json" */
export function canvasElementText(target: Extract<ThreadTarget, { kind: "canvas-element" }>): string {
  const summary = target.elementSummary ? `, ${target.elementSummary}` : "";
  return `the canvas element \`${target.elementId}\` (${target.elementKind}${summary}) of manifest.json`;
}
