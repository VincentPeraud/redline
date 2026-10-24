import { expect, it } from "vitest";
import { REDLINE_GUIDE } from "../src/guide.js";

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
