import { describe, expect, it } from "vitest";
import { presentationOf } from "../src/playDevices.js";

const board = (over: { width: number; height: number; device?: "phone" | "tablet" | "desktop" | "paper" | "none" }) => ({
  file: "a.html",
  x: 0,
  y: 0,
  ...over,
});

describe("presentationOf", () => {
  it("uses the declared device", () => {
    expect(presentationOf(board({ width: 800, height: 500, device: "tablet" })).device).toBe("tablet");
    expect(presentationOf(board({ width: 390, height: 800, device: "none" })).device).toBe("none");
  });

  it("infers a phone from a portrait artboard at most 500px wide, else none", () => {
    expect(presentationOf(board({ width: 390, height: 844 })).device).toBe("phone");
    expect(presentationOf(board({ width: 500, height: 501 })).device).toBe("phone");
    expect(presentationOf(board({ width: 501, height: 900 })).device).toBe("none");
    expect(presentationOf(board({ width: 400, height: 300 })).device).toBe("none");
  });

  it("gives a phone a fixed phone viewport and the others the artboard size", () => {
    expect(presentationOf(board({ width: 360, height: 640, device: "phone" })).viewport).toEqual({ width: 390, height: 760 });
    expect(presentationOf(board({ width: 576, height: 746, device: "tablet" })).viewport).toEqual({ width: 576, height: 746 });
    expect(presentationOf(board({ width: 1440, height: 900, device: "desktop" })).viewport).toEqual({ width: 1440, height: 900 });
  });

  it("drops the frame when the viewer turns Habillage off, phone and tablet keep their width at full height, desktop fills", () => {
    const phone = presentationOf(board({ width: 390, height: 844, device: "phone" }), false);
    expect([phone.device, phone.fill, phone.framable]).toEqual(["none", "height", true]);
    const tablet = presentationOf(board({ width: 576, height: 746, device: "tablet" }), false);
    expect([tablet.device, tablet.fill, tablet.framable]).toEqual(["none", "height", true]);
    const desktop = presentationOf(board({ width: 1440, height: 900, device: "desktop" }), false);
    expect([desktop.device, desktop.fill, desktop.framable]).toEqual(["none", "both", true]);
    expect(presentationOf(board({ width: 1440, height: 900, device: "desktop" })).fill).toBe("none");
  });

  it("offers no Habillage for an artboard without a frame", () => {
    const plain = presentationOf(board({ width: 800, height: 500 }));
    expect([plain.framable, plain.fill]).toEqual([false, "none"]);
  });

  it("fills the screen without a frame below 600px for a phone and 1100px for a tablet", () => {
    const phone = presentationOf(board({ width: 390, height: 844, device: "phone" }), true, 599);
    expect([phone.device, phone.fill, phone.framable, phone.mobileBar]).toEqual(["none", "both", false, true]);
    expect(presentationOf(board({ width: 390, height: 844, device: "phone" }), true, 600).device).toBe("phone");
    const tablet = presentationOf(board({ width: 576, height: 746, device: "tablet" }), true, 1099);
    expect([tablet.device, tablet.fill, tablet.framable, tablet.mobileBar]).toEqual(["none", "both", false, false]);
    expect(presentationOf(board({ width: 576, height: 746, device: "tablet" }), true, 1100).device).toBe("tablet");
    expect(presentationOf(board({ width: 1440, height: 900, device: "desktop" }), true, 500).device).toBe("desktop");
  });
});
