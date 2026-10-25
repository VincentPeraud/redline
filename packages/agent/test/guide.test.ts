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
