import { describe, expect, it } from "vitest";
import { analyseGaps, parseTokens, type GapContext } from "@redline/shared";

const tokens = parseTokens(`:root {
  --color-primary: #ff5a1f;
  --font-heading: "Fraunces", serif;
  --font-body: Inter, sans-serif;
  --color-accent: var(--color-highlight); /* deprecated: renamed to --color-highlight */
  --color-highlight: #8b5cf6;
}`);
const context: GapContext = {
  tokens,
  components: [
    { name: "post-cta", classes: ["post-cta"] },
    { name: "field", classes: ["field", "field-label"] },
  ],
};
const page = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const gaps = (html: string, ctx: GapContext = context) => analyseGaps("story.html", html, ctx);

describe("hard-coded fonts", () => {
  it("reports the first family of a font-family written without var(), suggesting the body token", () => {
    const found = gaps(page('<p style="font-family: Arial, sans-serif">x</p>'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "font", value: "Arial", suggestion: { token: "--font-body" } });
  });

  it("suggests the heading token on a heading and strips quotes", () => {
    const found = gaps(page("<h2 style=\"font-family: 'Times New Roman'\">x</h2>"));
    expect(found[0]).toMatchObject({ value: "Times New Roman", suggestion: { token: "--font-heading" } });
  });

  it("ignores font-family through a token, with or without fallback, and CSS keywords", () => {
    const html = page('<p style="font-family: var(--font-body, Arial)">a</p><p style="font-family: var(--font-body), Arial">b</p><p style="font-family: inherit">c</p>');
    expect(gaps(html)).toEqual([]);
  });
});

describe("controls without a component class", () => {
  it("reports a button when a component of that kind exists, naming it", () => {
    const found = gaps(page("<button>Go</button>"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "control", value: "<button>", selector: "body > button", suggestion: { component: "post-cta" } });
  });

  it("accepts any class of a design system or project component", () => {
    expect(gaps(page('<button class="big post-cta">Go</button><input class="field">'))).toEqual([]);
    expect(gaps(page('<input class="post-cta">'))).toEqual([]);
  });

  it("reports nothing for a kind with no component, nor for hidden inputs", () => {
    expect(gaps(page('<select><option>a</option></select><textarea></textarea>'), { ...context, components: [{ name: "post-cta", classes: ["post-cta"] }] })).toEqual([]);
    expect(gaps(page('<input type="hidden">'))).toEqual([]);
  });

  it("matches input and textarea to field components", () => {
    const found = gaps(page("<input><textarea></textarea>"));
    expect(found.map((g) => [g.value, g.suggestion?.component])).toEqual([["<input>", "field"], ["<textarea>", "field"]]);
  });

  it("adds the component to the colour gap of a control", () => {
    const found = gaps(page('<button style="background:#ff6b00">Go</button>'));
    expect(found.find((g) => g.kind === "color")!.suggestion).toEqual({ token: "--color-primary", component: "post-cta" });
  });
});

describe("deprecated tokens", () => {
  it("reports a use of a deprecated token with its replacement, in styles and attributes", () => {
    const found = gaps(page('<p style="color: var(--color-accent)">x</p>', "<style>p { border-color: var(--color-accent, red) }</style>"));
    expect(found.map((g) => [g.kind, g.value, g.suggestion?.token])).toEqual([["deprecated", "--color-accent", "--color-highlight"]]);
  });

  it("does not report a token that is not deprecated", () => {
    expect(gaps(page('<p style="color: var(--color-highlight)">x</p>'))).toEqual([]);
  });
});

describe("data-ds-libre", () => {
  it("skips the element and its descendants, whatever the gap", () => {
    const html = page('<div data-ds-libre><button style="color:#fff; font-family: Arial">x</button><p style="color: var(--color-accent)">y</p></div><p style="color:#fff">z</p>');
    expect(gaps(html).map((g) => g.selector)).toEqual(["body > p"]);
  });

  it("skips a stylesheet rule that only reaches free elements", () => {
    const html = page('<p data-ds-libre class="free">x</p><p class="kept">y</p>', "<style>.free { color: #f00 } .kept { color: #0f0 }</style>");
    expect(gaps(html).map((g) => g.value)).toEqual(["#0f0"]);
  });
});
