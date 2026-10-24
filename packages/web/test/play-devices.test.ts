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
});
