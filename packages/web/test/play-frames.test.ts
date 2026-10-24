import { describe, expect, it } from "vitest";
import { presentationOf } from "../src/playFrames.js";

const board = (over: { width: number; height: number; frame?: "phone" | "tablet" | "browser" | "paper"; expand?: "fill" }) => ({
  file: "a.html",
  x: 0,
  y: 0,
  ...over,
});

describe("presentationOf", () => {
  it("uses the declared frame", () => {
    expect(presentationOf(board({ width: 800, height: 500, frame: "tablet" })).frame).toBe("tablet");
    expect(presentationOf(board({ width: 390, height: 800 })).frame).toBe("none");
  });

  it("presents an artboard without a declared frame as is, whatever its size", () => {
    expect(presentationOf(board({ width: 390, height: 844 })).frame).toBe("none");
    expect(presentationOf(board({ width: 390, height: 844 })).viewport).toEqual({ width: 390, height: 844 });
    expect(presentationOf(board({ width: 400, height: 300 })).frame).toBe("none");
  });

  it("gives a phone a fixed phone viewport and the others the artboard size", () => {
    expect(presentationOf(board({ width: 360, height: 640, frame: "phone" })).viewport).toEqual({ width: 390, height: 760 });
    expect(presentationOf(board({ width: 576, height: 746, frame: "tablet" })).viewport).toEqual({ width: 576, height: 746 });
    expect(presentationOf(board({ width: 1440, height: 900, frame: "browser" })).viewport).toEqual({ width: 1440, height: 900 });
  });

  it("drops the frame when the viewer turns Habillage off, phone and tablet keep their width at full height, browser fills", () => {
    const phone = presentationOf(board({ width: 390, height: 844, frame: "phone" }), false);
    expect([phone.frame, phone.fill, phone.framable]).toEqual(["none", "height", true]);
    const tablet = presentationOf(board({ width: 576, height: 746, frame: "tablet" }), false);
    expect([tablet.frame, tablet.fill, tablet.framable]).toEqual(["none", "height", true]);
    const browser = presentationOf(board({ width: 1440, height: 900, frame: "browser" }), false);
    expect([browser.frame, browser.fill, browser.framable]).toEqual(["none", "both", true]);
    expect(presentationOf(board({ width: 1440, height: 900, frame: "browser" })).fill).toBe("none");
  });

  it("offers no Habillage for an artboard without a frame", () => {
    const plain = presentationOf(board({ width: 800, height: 500 }));
    expect([plain.framable, plain.fill]).toEqual([false, "none"]);
  });

  it("keeps a paper sheet whatever the Habillage switch says, and offers no Habillage for it", () => {
    const sheet = board({ width: 576, height: 814, frame: "paper" });
    expect(presentationOf(sheet)).toMatchObject({ frame: "paper", framable: false });
    expect(presentationOf(sheet, false)).toMatchObject({ frame: "paper", framable: false, fill: "none" });
  });

  it("fills the screen without a frame below 600px for a phone and 1100px for a tablet", () => {
    const phone = presentationOf(board({ width: 390, height: 844, frame: "phone" }), true, 599);
    expect([phone.frame, phone.fill, phone.framable, phone.mobileBar]).toEqual(["none", "both", false, true]);
    expect(presentationOf(board({ width: 390, height: 844, frame: "phone" }), true, 600).frame).toBe("phone");
    const tablet = presentationOf(board({ width: 576, height: 746, frame: "tablet" }), true, 1099);
    expect([tablet.frame, tablet.fill, tablet.framable, tablet.mobileBar]).toEqual(["none", "both", false, false]);
    expect(presentationOf(board({ width: 576, height: 746, frame: "tablet" }), true, 1100).frame).toBe("tablet");
    expect(presentationOf(board({ width: 1440, height: 900, frame: "browser" }), true, 500).frame).toBe("browser");
  });

  it("fills the stage when the artboard expands, except a phone", () => {
    const filled = presentationOf({ ...board({ width: 1440, height: 900, frame: "browser" }), expand: "fill" });
    expect(filled).toMatchObject({ frame: "none", fill: "both", frameHeight: 0, stagePadding: 0 });
    expect(presentationOf({ ...board({ width: 800, height: 500 }), expand: "fill" }).fill).toBe("both");
    expect(presentationOf(board({ width: 800, height: 500 })).fill).toBe("none");
    const phone = presentationOf({ ...board({ width: 390, height: 844, frame: "phone" }), expand: "fill" });
    expect(phone).toMatchObject({ frame: "phone", fill: "none" });
    expect(presentationOf({ ...board({ width: 390, height: 844 }), expand: "fill" })).toMatchObject({ frame: "none", fill: "both" });
  });
});

describe("presentationOf for a responsive rendering", () => {
  const group = board({ width: 3000, height: 1000 });
  const rendering = (format: "desktop" | "tablet-landscape" | "tablet" | "mobile", width: number, height: number) => ({ format, width, height });

  it("uses the frame of the format at the rendering size", () => {
    expect(presentationOf(group, true, 1440, rendering("desktop", 1440, 900))).toMatchObject({ frame: "browser", viewport: { width: 1440, height: 900 }, framable: true });
    expect(presentationOf(group, true, 1440, rendering("tablet", 768, 1024))).toMatchObject({ frame: "tablet", viewport: { width: 768, height: 1024 } });
    expect(presentationOf(group, true, 1440, rendering("tablet-landscape", 1024, 768))).toMatchObject({ frame: "tablet", viewport: { width: 1024, height: 768 } });
    expect(presentationOf(group, true, 1440, rendering("mobile", 414, 896))).toMatchObject({ frame: "phone", viewport: { width: 414, height: 896 } });
  });

  it("follows the Habillage switch and the narrow-window rules of the frame", () => {
    expect(presentationOf(group, false, 1440, rendering("mobile", 390, 844))).toMatchObject({ frame: "none", fill: "height" });
    expect(presentationOf(group, true, 500, rendering("mobile", 390, 844))).toMatchObject({ frame: "none", fill: "both", mobileBar: true });
    expect(presentationOf(group, true, 600, rendering("mobile", 390, 844))).toMatchObject({ frame: "phone", mobileBar: false });
    expect(presentationOf(group, true, 500, rendering("desktop", 1440, 900))).toMatchObject({ frame: "browser", mobileBar: false });
    expect(presentationOf(group, true, 1000, rendering("tablet", 768, 1024))).toMatchObject({ frame: "none", mobileBar: false });
  });

  it("shows the whole window for Aucun", () => {
    expect(presentationOf(group, true, 1440, null)).toMatchObject({ frame: "none", fill: "both", framable: false, mobileBar: false });
  });
});
