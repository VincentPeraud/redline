import { expect, it } from "vitest";
import { REDLINE_GUIDE } from "../src/guide.js";

it("tells Claude to design the project style first when a project without a design system has an empty one", () => {
  expect(REDLINE_GUIDE).toContain("### Project without a shared design system");
  expect(REDLINE_GUIDE).toContain("before the first artboard");
  expect(REDLINE_GUIDE).toContain("one to three typefaces, a ground, one or two accents of similar chroma and lightness");
  expect(REDLINE_GUIDE).toContain("at least the core tokens");
  expect(REDLINE_GUIDE).toContain("say in your answer what you chose");
  expect(REDLINE_GUIDE).toContain("in every artboard");
});

it("tells Claude to keep an existing project style and change it only on request", () => {
  expect(REDLINE_GUIDE).toContain("When it already holds values, use them");
  expect(REDLINE_GUIDE).toContain("only when the user asks for a different look");
});

it("says a project without a shared design system has no gaps and needs no data-ds-libre", () => {
  expect(REDLINE_GUIDE).toContain("No gaps are reported");
  expect(REDLINE_GUIDE).toContain("data-ds-libre is not needed");
  expect(REDLINE_GUIDE).not.toContain("A page without a design system has the neutral one");
});

it("scopes 'never override on your own initiative' to projects with a shared design system", () => {
  expect(REDLINE_GUIDE).toContain("### Project with a shared design system");
  expect(REDLINE_GUIDE).toContain("With a shared design system, override only when the user asks");
  expect(REDLINE_GUIDE).toContain("Never override on your own initiative");
});

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
  expect(REDLINE_GUIDE).toContain("override only when the user asks");
  expect(REDLINE_GUIDE).toContain("/* deprecated: renamed to --new */");
  expect(REDLINE_GUIDE).toContain("Hint:");
});

it("tells Claude that a removal in use is refused until the user agrees and confirm_removals is called", () => {
  expect(REDLINE_GUIDE).toContain("is refused at publish");
  expect(REDLINE_GUIDE).not.toContain("may be refused");
  expect(REDLINE_GUIDE).toContain("confirm_removals");
});

it("explains how to recreate a Claude Design design system and the terminal tools", () => {
  expect(REDLINE_GUIDE).toContain("## Recreating a Claude Design design system");
  expect(REDLINE_GUIDE).toContain("README");
  expect(REDLINE_GUIDE).toContain("tokens.json");
  expect(REDLINE_GUIDE).toContain("create_design_system");
  expect(REDLINE_GUIDE).toContain("set_project_design_system");
  expect(REDLINE_GUIDE).toContain("list_design_systems");
});

it("tells Claude to anchor elements under notes instead of guessing their height", () => {
  expect(REDLINE_GUIDE).toContain("their font is 16, 18 or 22 canvas pixels (s, m, l)");
  expect(REDLINE_GUIDE).toContain('"below": "<id or artboard file>" or "rightOf": "<id or artboard file>"');
  expect(REDLINE_GUIDE).toContain("optional \"gap\" (default 40)");
  expect(REDLINE_GUIDE).toContain("Titles and arrows cannot be anchored.");
});

it("gives spacing, arrow, content and asking rules, so pages come out clean without the user's corrections", () => {
  expect(REDLINE_GUIDE).toContain("80 px between the artboards of a row");
  expect(REDLINE_GUIDE).toContain("never link two boxes with another box between them");
  expect(REDLINE_GUIDE).toContain("no lorem ipsum");
  expect(REDLINE_GUIDE).toContain("[PRIX]");
  expect(REDLINE_GUIDE).toContain("contrast of 4.5:1");
  expect(REDLINE_GUIDE).toContain("state your assumptions in one line");
});

it("tells terminal Claude to call release_page only when asked to let go of a page", () => {
  expect(REDLINE_GUIDE).toContain("## Letting go of a page (terminal mode)");
  expect(REDLINE_GUIDE).toContain("release_page {pageId}");
  expect(REDLINE_GUIDE).toContain("Never release a page on your own");
});

it("tells Claude how to try variants of a design system component's look in a project", () => {
  expect(REDLINE_GUIDE).toContain("Trying looks of a component");
  expect(REDLINE_GUIDE).toContain('data-ds-libre="essai"');
  expect(REDLINE_GUIDE).toContain("send_request with the chosen trial");
  expect(REDLINE_GUIDE).toContain("never as the page's real component");
});
