import { describe, expect, it } from "vitest";
import { EMPTY_VIEW_SETTINGS, type ArtboardRendering, type PageViewSettings, type Thread } from "@redline/shared";
import { hiddenRenderingKeys, hiddenThreadCounts, setFormatShown, toggleRendering } from "../src/viewSettings.js";

const renderings: ArtboardRendering[] = [
  { format: "desktop", width: 1440, height: 900 },
  { format: "tablet", width: 768, height: 1024 },
  { format: "mobile", width: 390, height: 844 },
];

describe("hiddenRenderingKeys", () => {
  it("hides nothing by default", () => {
    expect([...hiddenRenderingKeys(renderings, EMPTY_VIEW_SETTINGS, "a.html")]).toEqual([]);
  });

  it("hides the renderings of a hidden format, and a frame's own choice wins", () => {
    const settings: PageViewSettings = { hiddenFormats: ["mobile", "tablet"], renderingOverrides: { "a.html": { "mobile-390": true } } };
    expect([...hiddenRenderingKeys(renderings, settings, "a.html")]).toEqual(["tablet-768"]);
    expect([...hiddenRenderingKeys(renderings, settings, "b.html")]).toEqual(["tablet-768", "mobile-390"]);
  });

  it("always keeps the first rendering when everything would be hidden", () => {
    const settings: PageViewSettings = { hiddenFormats: ["desktop", "tablet", "mobile"], renderingOverrides: {} };
    expect([...hiddenRenderingKeys(renderings, settings, "a.html")]).toEqual(["tablet-768", "mobile-390"]);
  });
});

describe("toggleRendering", () => {
  it("records the frame's exception, and removes it when it matches the format again", () => {
    const hidden = toggleRendering(EMPTY_VIEW_SETTINGS, "a.html", renderings, "mobile-390");
    expect(hidden.renderingOverrides).toEqual({ "a.html": { "mobile-390": false } });
    expect(toggleRendering(hidden, "a.html", renderings, "mobile-390")).toEqual(EMPTY_VIEW_SETTINGS);
  });

  it("refuses to hide the last visible rendering", () => {
    const settings: PageViewSettings = { hiddenFormats: ["tablet", "mobile"], renderingOverrides: {} };
    expect(toggleRendering(settings, "a.html", renderings, "desktop-1440")).toBe(settings);
  });
});

describe("setFormatShown", () => {
  it("applies to every frame and clears their exceptions for that format only", () => {
    const settings: PageViewSettings = {
      hiddenFormats: [],
      renderingOverrides: { "a.html": { "mobile-390": true, "desktop-1440": false }, "b.html": { "mobile-390": false } },
    };
    expect(setFormatShown(settings, "mobile", false)).toEqual({
      hiddenFormats: ["mobile"],
      renderingOverrides: { "a.html": { "desktop-1440": false } },
    });
    expect(setFormatShown(setFormatShown(settings, "mobile", false), "mobile", true).hiddenFormats).toEqual([]);
  });

  it("clearing tablet keeps the exceptions of tablet-landscape", () => {
    const settings: PageViewSettings = { hiddenFormats: [], renderingOverrides: { "a.html": { "tablet-landscape-1024": false, "tablet-768": false } } };
    expect(setFormatShown(settings, "tablet", false).renderingOverrides).toEqual({ "a.html": { "tablet-landscape-1024": false } });
  });
});

describe("hiddenThreadCounts", () => {
  it("counts, per hidden rendering, the threads of that artboard pinned in it", () => {
    const thread = (artboard: string, rendering?: { format: "mobile" | "desktop"; width: number }) => ({ artboard, rendering }) as Thread;
    const threads = [
      thread("a.html", { format: "mobile", width: 390 }),
      thread("a.html", { format: "mobile", width: 390 }),
      thread("b.html", { format: "mobile", width: 390 }),
      thread("a.html", { format: "desktop", width: 1440 }),
      thread("a.html"),
    ];
    expect(hiddenThreadCounts(threads, "a.html", new Set(["mobile-390", "tablet-768"]))).toEqual({ "mobile-390": 2, "tablet-768": 0 });
  });
});
