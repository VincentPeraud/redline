import { describe, expect, it } from "vitest";
import { canvasElementSummary, type ManifestElement } from "@redline/shared";

const at = { x: 0, y: 0 };

describe("canvasElementSummary", () => {
  it("shows the text of titles, text notes and sticky notes on one line", () => {
    expect(canvasElementSummary({ kind: "title", text: "Parcours billet", width: 600, ...at })).toBe("« Parcours billet »");
    expect(canvasElementSummary({ kind: "sticky", text: "Line one\n\nline  two", width: 240, size: "m", color: "yellow", ...at })).toBe("« Line one line two »");
  });

  it("cuts a long text", () => {
    const summary = canvasElementSummary({ kind: "text", text: "a".repeat(300), width: 300, size: "m", ...at });
    expect(summary).toBe(`« ${"a".repeat(120)}… »`);
  });

  it("shows the label of shapes and arrows, and nothing when they have none", () => {
    const shape: ManifestElement = { kind: "shape", shape: "rect", style: "outline", color: "blue", width: 10, height: 10, ...at };
    expect(canvasElementSummary({ ...shape, label: "Variantes" })).toBe("« Variantes »");
    expect(canvasElementSummary(shape)).toBe("");
  });

  it("shows the link target and the image file", () => {
    expect(canvasElementSummary({ kind: "link", url: "https://example.com", title: "Menu", ...at })).toBe("https://example.com");
    expect(canvasElementSummary({ kind: "link", page: "p-1", ...at })).toBe("link to page p-1");
    expect(canvasElementSummary({ kind: "image", src: "assets/a.png", width: 100, ...at })).toBe("assets/a.png");
  });
});
