import { describe, expect, it } from "vitest";
import { parseTokens, removeToken, setToken, tokenValueError } from "@redline/shared";

describe("parseTokens", () => {
  it("lists custom properties in declaration order with their values", () => {
    const css = `:root {\n  --color-primary: #18181b;\n  --radius: 6px;\n  --font-body: "Inter", system-ui, sans-serif;\n}`;
    expect(parseTokens(css).map(({ name, value }) => [name, value])).toEqual([
      ["--color-primary", "#18181b"],
      ["--radius", "6px"],
      ["--font-body", '"Inter", system-ui, sans-serif'],
    ]);
  });

  it("ignores ordinary properties, selectors and plain comments", () => {
    const css = `/* brand */\n:root { color: red; --space-unit: 8px; /* base */ }\n.a { --local: 1; margin: 0 }`;
    expect(parseTokens(css).map((t) => t.name)).toEqual(["--space-unit", "--local"]);
  });

  it("tells colours from other values", () => {
    const css = `:root {
      --a: #fff; --b: #18181bcc; --c: rgb(0 0 0 / 50%); --d: hsl(20, 10%, 10%); --e: oklch(0.5 0.1 20);
      --f: transparent; --g: 8px; --h: "Inter", sans-serif; --i: var(--a); --j: red; --k: 1.5;
    }`;
    const colours = Object.fromEntries(parseTokens(css).map((t) => [t.name, t.isColor]));
    expect(colours).toEqual({
      "--a": true, "--b": true, "--c": true, "--d": true, "--e": true, "--f": true,
      "--g": false, "--h": false, "--i": false, "--j": true, "--k": false,
    });
  });

  it("reports the deprecation marker of an alias", () => {
    const css = `:root {\n  --color-accent: var(--color-primary); /* deprecated: renamed to --color-primary */\n  --color-primary: #111;\n}`;
    expect(parseTokens(css)).toEqual([
      { name: "--color-accent", value: "var(--color-primary)", isColor: false, deprecatedFor: "--color-primary" },
      { name: "--color-primary", value: "#111", isColor: true },
    ]);
  });

  it("keeps the last declaration of a name, at its first position", () => {
    expect(parseTokens(`:root { --a: 1px; --b: 2px; --a: 3px; }`).map((t) => [t.name, t.value])).toEqual([["--a", "3px"], ["--b", "2px"]]);
  });

  it("returns nothing for empty css", () => {
    expect(parseTokens("")).toEqual([]);
  });
});

describe("setToken and removeToken", () => {
  const css = `/* brand */\n:root {\n  --color-primary: #18181b;\n  --radius: 6px;\n}\n`;

  it("replaces the value of a declared token and keeps the rest of the file", () => {
    expect(setToken(css, "--radius", "12px")).toBe(`/* brand */\n:root {\n  --color-primary: #18181b;\n  --radius: 12px;\n}\n`);
  });

  it("adds a missing token at the end of the last block", () => {
    expect(setToken(css, "--space-unit", "8px")).toBe(`/* brand */\n:root {\n  --color-primary: #18181b;\n  --radius: 6px;\n  --space-unit: 8px;\n}\n`);
  });

  it("creates a :root block when the file has none", () => {
    expect(parseTokens(setToken("", "--radius", "4px"))).toEqual([{ name: "--radius", value: "4px", isColor: false }]);
  });

  it("removes a token", () => {
    expect(removeToken(css, "--radius")).toBe(`/* brand */\n:root {\n  --color-primary: #18181b;\n}\n`);
  });

  it("does not mistake a longer name for the token", () => {
    expect(setToken(":root { --color-primary-dark: red; }", "--color-primary", "blue")).toContain("--color-primary-dark: red;");
  });

  it("refuses values that would break the file", () => {
    for (const value of ["", "red; color: blue", "a } b", "a\nb", "/* x */"]) expect(tokenValueError(value)).not.toBeNull();
    expect(tokenValueError('"Inter", system-ui')).toBeNull();
  });
});
