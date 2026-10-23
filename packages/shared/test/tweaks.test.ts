import { describe, expect, it } from "vitest";
import { parseManifest, parseTweaks, resolveTweakValues, tweakValueError, type ManifestTweak } from "@redline/shared";

const manifest = parseManifest(
  JSON.stringify({
    tweaks: [
      { id: "accent", type: "color", label: "Accent", default: "#e5484d" },
      { id: "layout", type: "choice", label: "Layout", options: ["list", "grid"] },
      { id: "search", type: "toggle", label: "Search" },
      { id: "gap", type: "range", label: "Gap", min: 4, max: 24 },
      { id: "cards", type: "count", label: "Cards", min: 1, max: 6, default: 3 },
      { id: "title", type: "text", label: "Title" },
    ],
  }),
);

describe("tweak values", () => {
  it("falls back from the stored value to the declared default to a type default", () => {
    expect(resolveTweakValues(manifest, { accent: "#000000", gap: 10 })).toEqual({
      accent: "#000000",
      layout: "list",
      search: false,
      gap: 10,
      cards: 3,
      title: "",
    });
  });

  it("ignores stored values that are not declared or do not fit the declaration", () => {
    const values = resolveTweakValues(manifest, { layout: "carousel", gap: 99, ghost: 1 });
    expect(values.layout).toBe("list");
    expect(values.gap).toBe(4);
    expect("ghost" in values).toBe(false);
  });

  it("validates a value against its tweak type", () => {
    const tweak = (id: string) => manifest.tweaks.find((t) => t.id === id) as ManifestTweak;
    expect(tweakValueError(tweak("accent"), "#abc")).toBeNull();
    expect(tweakValueError(tweak("accent"), "red")).toMatch(/color/);
    expect(tweakValueError(tweak("layout"), "grid")).toBeNull();
    expect(tweakValueError(tweak("layout"), "carousel")).toMatch(/options/);
    expect(tweakValueError(tweak("search"), true)).toBeNull();
    expect(tweakValueError(tweak("search"), "yes")).toMatch(/boolean/);
    expect(tweakValueError(tweak("gap"), 4.5)).toBeNull();
    expect(tweakValueError(tweak("gap"), 30)).toMatch(/between/);
    expect(tweakValueError(tweak("cards"), 2.5)).toMatch(/integer/);
    expect(tweakValueError(tweak("title"), "Hi")).toBeNull();
    expect(tweakValueError(tweak("title"), 1)).toMatch(/string/);
  });
});

describe("tweaks file", () => {
  it("is a flat JSON object of id to value", () => {
    expect(parseTweaks('{"accent":"#fff","search":true}')).toEqual({ accent: "#fff", search: true });
  });

  it("rejects anything else", () => {
    expect(() => parseTweaks("nope")).toThrow(/Invalid tweaks.json/);
    expect(() => parseTweaks("[1]")).toThrow(/Invalid tweaks.json/);
    expect(() => parseTweaks('{"a":{"b":1}}')).toThrow(/Invalid tweaks.json/);
  });
});
