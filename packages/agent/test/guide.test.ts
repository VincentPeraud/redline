import { expect, it } from "vitest";
import { REDLINE_GUIDE } from "../src/guide.js";

it("explains the project style: tokens.css wins over the design system, DESIGN.md of the project wins on conflict", () => {
  expect(REDLINE_GUIDE).toContain("## Project style (tokens.css)");
  expect(REDLINE_GUIDE).toContain("wins over the design system's token of the same name");
  expect(REDLINE_GUIDE).toContain("the project's DESIGN.md wins");
});

it("tells Claude that every element needs a stable, readable id", () => {
  expect(REDLINE_GUIDE).toContain("Every element, arrows included, needs an \"id\"");
  expect(REDLINE_GUIDE).toContain("fleche-vers-paiement");
  expect(REDLINE_GUIDE).toContain("Keep an element's id when you edit or move it");
});

it("explains aiming a link card at an artboard with file", () => {
  expect(REDLINE_GUIDE).toContain('{ "kind": "link", "page": "<page id>", "file": "<artboard file>"');
  expect(REDLINE_GUIDE).toContain("artboard of that page");
});

it("documents the context block that follows a conversation message", () => {
  expect(REDLINE_GUIDE).toContain("The user is looking at: <files>");
  expect(REDLINE_GUIDE).toContain("Elements the user points at:");
  expect(REDLINE_GUIDE).toContain("Tweak values: <label>: <value>");
});

it("tells Claude to write full artboard addresses and that the reading order is the canvas layout", () => {
  expect(REDLINE_GUIDE).toContain("full address");
  expect(REDLINE_GUIDE).toContain("reading order");
  expect(REDLINE_GUIDE).toContain("left to right, row by row");
});

it("explains play links to an artboard of another page with `page`", () => {
  expect(REDLINE_GUIDE).toContain('"links": [{ "from", "selector", "to", "page"? }]');
  expect(REDLINE_GUIDE).toContain('add "page" (a page id of the same project) to go to an artboard of another page');
});

it("documents move_artboard, its target page id and its refusals", () => {
  expect(REDLINE_GUIDE).toContain("move_artboard {file, pageId | newPageTitle}");
  expect(REDLINE_GUIDE).toContain("reuse it for the next artboards");
  expect(REDLINE_GUIDE).toContain("another session works on either page");
});

it("documents the design system folder, 'Ce projet utilise' and design system sessions editing tokens.css", () => {
  expect(REDLINE_GUIDE).toContain("## Design system and components");
  expect(REDLINE_GUIDE).toContain(".design-system/");
  expect(REDLINE_GUIDE).toContain("Ce projet utilise");
  expect(REDLINE_GUIDE).toContain("design system session");
  expect(REDLINE_GUIDE).toContain("draft");
  expect(REDLINE_GUIDE).toContain("Never edit a shared design system from a project session");
});

it("lists the recommended extra token names and asks for var() fallbacks", () => {
  for (const name of ["--color-accent", "--color-success", "--color-warning", "--color-error", "--text-xs", "--text-3xl", "--shadow", "--radius-sm", "--radius-lg"]) {
    expect(REDLINE_GUIDE).toContain(name);
  }
  expect(REDLINE_GUIDE).toContain("nothing refuses other names");
});

it("explains components: file layout, description, usage, variants as tweaks, data-state, data-ds-libre", () => {
  expect(REDLINE_GUIDE).toContain("components/<name>.html");
  expect(REDLINE_GUIDE).toContain('<meta name="description"');
  expect(REDLINE_GUIDE).toContain("<template data-usage>");
  expect(REDLINE_GUIDE).toContain("<style data-component>");
  expect(REDLINE_GUIDE).toContain("Variants are tweaks");
  expect(REDLINE_GUIDE).toContain("data-ds-libre");
});

it("explains overrides, deprecated aliases and the publish hint", () => {
  expect(REDLINE_GUIDE).toContain("Override only when the user asks");
  expect(REDLINE_GUIDE).toContain("/* deprecated: renamed to --new */");
  expect(REDLINE_GUIDE).toContain("Hint:");
});

it("explains how to recreate a Claude Design design system and the terminal tools", () => {
  expect(REDLINE_GUIDE).toContain("## Recreating a Claude Design design system");
  expect(REDLINE_GUIDE).toContain("README");
  expect(REDLINE_GUIDE).toContain("tokens.json");
  expect(REDLINE_GUIDE).toContain("create_design_system");
  expect(REDLINE_GUIDE).toContain("set_project_design_system");
  expect(REDLINE_GUIDE).toContain("list_design_systems");
});
