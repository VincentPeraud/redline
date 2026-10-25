import { describe, expect, it } from "vitest";
import { analyseGaps, parseTokens, type GapContext } from "@redline/shared";

const tokens = parseTokens(`:root {
  --color-primary: #ff5a1f;
  --color-text: #18181b;
  --color-surface: #ffffff;
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

describe("hard-coded colours", () => {
  it("reports a hex colour in a style attribute with the closest token and the element path", () => {
    const found = gaps(page('<div><p>Hi</p><span style="color: #FF6B00">x</span></div>'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      file: "story.html",
      kind: "color",
      value: "#FF6B00",
      element: "span",
      selector: "body > div > span",
      suggestion: { token: "--color-primary" },
    });
  });

  it("reports rgb() and rgba() colours, whole, in any property", () => {
    const found = gaps(page('<p style="border: 1px solid rgba(0, 0, 0, 0.2); background: rgb(250 250 250)">x</p>'));
    expect(found.map((g) => g.value)).toEqual(["rgba(0, 0, 0, 0.2)", "rgb(250 250 250)"]);
  });

  it("ignores colours inside the fallback of var()", () => {
    expect(gaps(page('<p style="color: var(--color-text, #111); background: var(--color-surface, rgb(1,2,3))">x</p>'))).toEqual([]);
  });

  it("reports colours of a stylesheet on the element the selector matches", () => {
    const found = gaps(page('<div class="a"><button class="cta">Go</button></div>', "<style>.a .cta { background: #ff6b00; }</style>"));
    const colour = found.find((g) => g.kind === "color")!;
    expect(colour).toMatchObject({ value: "#ff6b00", selector: "body > div > button", element: "button" });
  });

  it("reports a stylesheet colour whose selector matches nothing, without an element", () => {
    const found = gaps(page("<p>x</p>", "<style>.nowhere { color: #f00 }</style>"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "color", value: "#f00", selector: null, element: null });
  });

  it("skips custom property definitions, keyframes and font-face blocks", () => {
    const css = ":root{--mine:#abc} @keyframes k{from{color:#fff}} @font-face{font-family:Foo;src:url(a.woff)}";
    expect(gaps(page("<p>x</p>", `<style>${css}</style>`))).toEqual([]);
  });

  it("looks inside @media blocks", () => {
    const found = gaps(page("<p>x</p>", "<style>@media (min-width: 600px) { p { color: #123456 } }</style>"));
    expect(found.map((g) => [g.value, g.selector])).toEqual([["#123456", "body > p"]]);
  });

  it("gives the same key to the same gap and a different one elsewhere", () => {
    const html = page('<p style="color:#fff">a</p><p style="color:#fff">b</p>');
    const keys = gaps(html).map((g) => g.key);
    expect(new Set(keys).size).toBe(2);
    expect(gaps(html).map((g) => g.key)).toEqual(keys);
  });

  it("paths use the id of the nearest element and nth-of-type among same tags", () => {
    const found = gaps(page('<section id="hero"><div></div><div style="color:#fff">x</div></section>'));
    expect(found[0].selector).toBe("#hero > div:nth-of-type(2)");
  });
});
