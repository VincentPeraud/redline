import { describe, expect, it } from "vitest";
import { MAX_FIT_HEIGHT } from "@redline/shared";
import { nextFitHeight } from "../src/useFitHeight.js";

describe("nextFitHeight", () => {
  it("takes the page height over the manifest placeholder", () => {
    expect(nextFitHeight(500, 1380, undefined)).toEqual({ height: 1380, growth: 880 });
  });

  it("keeps the height when the page reports the same one", () => {
    expect(nextFitHeight(1380, 1380, 880)).toBeUndefined();
  });

  it("follows a page that gets shorter", () => {
    expect(nextFitHeight(1380, 900, 880)).toEqual({ height: 900, growth: -480 });
  });

  it("stops a page that grows with its own viewport", () => {
    expect(nextFitHeight(600, 700, 100)).toBeUndefined();
  });

  it("never goes past the cap", () => {
    expect(nextFitHeight(500, MAX_FIT_HEIGHT + 1, undefined)).toBeUndefined();
  });
});
