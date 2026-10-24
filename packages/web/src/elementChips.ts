import { CANVAS_ELEMENT_KIND_LABELS, renderingKey, type ThreadTarget } from "@redline/shared";

/** Identity of a target: selecting it twice gives one chip. */
function targetKey(target: ThreadTarget): string {
  switch (target.kind) {
    case "element":
      return `element|${target.artboard}|${target.rendering ? renderingKey(target.rendering) : ""}|${target.selector}`;
    case "artboard":
      return `artboard|${target.artboard}`;
    case "canvas-element":
      return `canvas-element|${target.elementId}`;
  }
}

/** "accueil.html" -> "accueil": an artboard file as the chips show it. */
export const artboardLabel = (file: string): string => file.replace(/\.[^./]+$/, "");

/** The chips with `target` appended, unless it is already there. */
export function addChip(chips: ThreadTarget[], target: ThreadTarget): ThreadTarget[] {
  const key = targetKey(target);
  return chips.some((chip) => targetKey(chip) === key) ? chips : [...chips, target];
}

export const removeChip = (chips: ThreadTarget[], index: number): ThreadTarget[] => chips.filter((_, i) => i !== index);

/** A chip's grey kind and bold name: "Bouton" + "Réserver ma place". */
export function chipParts(target: ThreadTarget): { kind: string; name?: string } {
  switch (target.kind) {
    case "element": {
      if (!target.elementName) return { kind: "Élément", name: target.selector };
      const [, role = target.elementName, text] = /^(.+?) « (.*) »$/.exec(target.elementName) ?? [];
      return { kind: role.charAt(0).toUpperCase() + role.slice(1), ...(text && { name: text }) };
    }
    case "artboard":
      return { kind: "Artboard", name: artboardLabel(target.artboard) };
    case "canvas-element":
      return { kind: CANVAS_ELEMENT_KIND_LABELS[target.elementKind], name: target.elementId };
  }
}

/** Numbered marks (position in the chips + 1) an artboard, or one rendering of it, draws for its element chips. */
export function marksFor(chips: ThreadTarget[], artboard: string, rendering?: string): { number: number; selector: string }[] {
  return chips.flatMap((chip, index) =>
    chip.kind === "element" && chip.artboard === artboard && (chip.rendering ? renderingKey(chip.rendering) : undefined) === rendering
      ? [{ number: index + 1, selector: chip.selector }]
      : [],
  );
}
