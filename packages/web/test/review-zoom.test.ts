import { describe, expect, it } from "vitest";
import { presentationOf } from "../src/playFrames.js";
import { MAX_REVIEW_ZOOM, MIN_REVIEW_ZOOM, openingZoom, reviewFit, stepZoom, zoomTagLabel } from "../src/reviewZoom.js";

const plain = (width: number, height: number) => presentationOf({ width, height });
const stage = { width: 1000, height: 700 };

describe("openingZoom", () => {
  it("fits an artboard a little taller than the stage, as a carousel slide", () => {
    // 1080 × 1350 on 1000 × 700: fitting shrinks it to 0.47 of 0.93, still readable.
    expect(openingZoom(plain(1080, 1350), stage)).toBe("fit");
  });

  it("keeps a long page at its width, to scroll", () => {
    expect(openingZoom(plain(1440, 4000), stage)).toBe("natural");
  });

  it("keeps an artboard that already fits as it is", () => {
    expect(openingZoom(plain(800, 500), stage)).toBe("natural");
  });
});

describe("reviewFit", () => {
  it("keeps today's fit in the natural mode", () => {
    expect(reviewFit(plain(390, 2400), stage, "natural")).toMatchObject({ scale: 1, scroll: "real", zoomable: true });
    expect(reviewFit(plain(400, 300), stage, "natural")).toMatchObject({ scale: 1, scroll: null });
  });

  it("fits the whole artboard in the stage, even enlarging a small one", () => {
    expect(reviewFit(plain(1080, 1350), stage, "fit")).toMatchObject({ scale: 636 / 1350, scroll: null });
    expect(reviewFit(plain(400, 300), stage, "fit")).toMatchObject({ scale: 636 / 300, scroll: null });
  });

  it("shows a chosen zoom, scrolling when the artboard overflows the stage", () => {
    expect(reviewFit(plain(800, 500), stage, 0.5)).toMatchObject({ scale: 0.5, scroll: null });
    expect(reviewFit(plain(800, 500), stage, 2)).toMatchObject({ scale: 2, scroll: "zoom" });
  });

  it("keeps the scroll decision it is given, so the stage padding that changes with it cannot make it flip", () => {
    expect(reviewFit(plain(800, 600), stage, 1.1, true).scroll).toBe("zoom");
    expect(reviewFit(plain(800, 600), stage, 1.1, false).scroll).toBeNull();
  });

  it("does not zoom a presentation that stretches to the stage", () => {
    const fill = presentationOf({ width: 1440, height: 900, expand: "fill" });
    expect(reviewFit(fill, stage, 2)).toMatchObject({ viewport: stage, scale: 1, scroll: null, zoomable: false });
  });
});

describe("stepZoom", () => {
  it("moves by one step and stays within the limits", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
    expect(stepZoom(MAX_REVIEW_ZOOM, 1)).toBe(MAX_REVIEW_ZOOM);
    expect(stepZoom(MIN_REVIEW_ZOOM, -1)).toBe(MIN_REVIEW_ZOOM);
  });
});

describe("zoomTagLabel", () => {
  it("says the zoom of a scrolled artboard", () => {
    expect(zoomTagLabel("zoom", 2, { width: 800, height: 500 })).toBe("200 % · 800 × 500 · fais défiler");
    expect(zoomTagLabel("real", 1, { width: 390, height: 2400 })).toBe("Taille réelle · 390 × 2400 · fais défiler");
  });
});
