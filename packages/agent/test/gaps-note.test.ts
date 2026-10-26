import { expect, it } from "vitest";
import type { Gap } from "@redline/shared";
import { gapsNote } from "../src/design-system-note.js";

const gap = (file: string, kind: Gap["kind"], value: string, suggestion?: Gap["suggestion"]): Gap => ({
  key: `${file}${kind}${value}${Math.random()}`,
  file,
  kind,
  value,
  element: "span",
  selector: "body > span",
  ...(suggestion ? { suggestion } : {}),
});

it("says nothing when there is no gap", () => {
  expect(gapsNote([])).toBeNull();
});

it("groups the gaps by value, with their count, files and suggestion, and says how to settle them", () => {
  const note = gapsNote([
    gap("sortie.html", "color", "#2563eb"),
    gap("sortie.html", "color", "#2563eb"),
    gap("vols.html", "color", "#2563eb"),
    gap("sortie.html", "color", "#fff", { token: "--color-on-primary" }),
    gap("sortie.html", "control", "<button>", { component: "btn" }),
  ])!;
  expect(note).toContain("5 design system gaps");
  expect(note).toContain("- colour #2563eb ×3 (sortie.html, vols.html)");
  expect(note).toContain("- colour #fff ×1 (sortie.html): use --color-on-primary");
  expect(note).toContain("- control <button> ×1 (sortie.html): use the component btn");
  expect(note).toContain("data-ds-libre");
});
