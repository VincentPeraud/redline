import { expect, it } from "vitest";
import { REDLINE_GUIDE } from "../src/guide.js";

it("tells Claude that every element needs a stable, readable id", () => {
  expect(REDLINE_GUIDE).toContain("Every element, arrows included, needs an \"id\"");
  expect(REDLINE_GUIDE).toContain("fleche-vers-paiement");
  expect(REDLINE_GUIDE).toContain("Keep an element's id when you edit or move it");
});
