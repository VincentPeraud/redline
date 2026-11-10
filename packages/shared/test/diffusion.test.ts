import { describe, expect, it } from "vitest";
import { diffDiffusionStates, diffusionSummary, type DiffusionState } from "@redline/shared";

const state = (over: Partial<DiffusionState> = {}): DiffusionState => ({
  tokensCss: ":root { --color-primary: #111; --radius: 6px; }",
  designMd: "# Rules",
  components: [{ name: "button", hash: "a1" }, { name: "badge", hash: "b1" }],
  ...over,
});

describe("diffDiffusionStates", () => {
  it("reports nothing when the states are the same", () => {
    const diff = diffDiffusionStates(state(), state());
    expect(diff.count).toBe(0);
    expect(diff.tokens).toEqual({ changed: [], added: [], removed: [] });
    expect(diff.components).toEqual({ added: [], changed: [], removed: [] });
    expect(diff.designMdChanged).toBe(false);
  });

  it("ignores formatting that leaves the token values alone", () => {
    const reformatted = state({ tokensCss: "/* brand */\n:root {\n  --radius: 6px;\n  --color-primary: #111;\n}" });
    expect(diffDiffusionStates(state(), reformatted).count).toBe(0);
  });

  it("lists changed tokens old -> new, added and removed ones", () => {
    const next = state({ tokensCss: ":root { --color-primary: #222; --space-unit: 8px; }" });
    const diff = diffDiffusionStates(state(), next);
    expect(diff.tokens.changed).toEqual([{ name: "--color-primary", from: "#111", to: "#222" }]);
    expect(diff.tokens.added).toEqual([{ name: "--space-unit", value: "8px" }]);
    expect(diff.tokens.removed).toEqual([{ name: "--radius", value: "6px" }]);
    expect(diff.count).toBe(3);
  });

  it("lists components added, changed by content hash, and removed", () => {
    const next = state({ components: [{ name: "button", hash: "a2" }, { name: "card", hash: "c1" }] });
    const diff = diffDiffusionStates(state(), next);
    expect(diff.components).toEqual({ added: ["card"], changed: ["button"], removed: ["badge"] });
    expect(diff.count).toBe(3);
  });

  it("reports a DESIGN.md change", () => {
    const diff = diffDiffusionStates(state(), state({ designMd: "# New rules" }));
    expect(diff.designMdChanged).toBe(true);
    expect(diff.count).toBe(1);
  });
});

describe("diffusionSummary", () => {
  it("counts what changed", () => {
    const diff = diffDiffusionStates(
      state(),
      state({ tokensCss: ":root { --color-primary: #222; --radius: 6px; }", components: [{ name: "button", hash: "a2" }, { name: "badge", hash: "b1" }], designMd: "x" }),
    );
    expect(diffusionSummary(diff)).toBe("1 token changed, 1 component changed, DESIGN.md changed");
  });
  it("has a sentence for an empty diff", () => {
    expect(diffusionSummary(diffDiffusionStates(state(), state()))).toBe("No change");
  });
});
