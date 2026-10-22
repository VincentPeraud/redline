import { expect, it } from "vitest";
import type { DesignMdRule } from "@redline/shared";
import { rulesToShow } from "../src/designMdRules.js";

const rule = (line: number, text: string, versionId: string, origin: DesignMdRule["origin"] = "user"): DesignMdRule => ({
  line,
  text,
  versionId,
  origin,
  createdAt: "2026-10-20T10:00:00Z",
});

it("lists every line of the text except headings and blanks, bullets without their dash, each with the origin the server found", () => {
  const text = "# Title\n\nCalm tone.\n## Rules\n- One action\n- Plain buttons";
  const info = [
    rule(1, "# Title", "v1"),
    rule(3, "Calm tone.", "v1"),
    rule(4, "## Rules", "v1"),
    rule(5, "- One action", "v1"),
    { ...rule(6, "- Plain buttons", "v2", "thread"), originLabel: "Bouton trop discret" },
  ];
  expect(rulesToShow(text, info).map((r) => [r.text, r.versionId])).toEqual([
    ["Calm tone.", "v1"],
    ["One action", "v1"],
    ["Plain buttons", "v2"],
  ]);
  expect(rulesToShow(text, info)[2]).toMatchObject({ origin: "thread", originLabel: "Bouton trop discret" });
});

it("leaves lines that are not in the saved version without an origin", () => {
  const info = [rule(1, "- One action", "v1")];
  expect(rulesToShow("- One action\n- Brand new", info)).toEqual([
    expect.objectContaining({ text: "One action", versionId: "v1" }),
    { text: "Brand new", versionId: undefined },
  ]);
});

it("matches repeated lines to the saved rules in order", () => {
  const info = [rule(1, "- Same", "v1"), rule(2, "- Same", "v2", "terminal")];
  const shown = rulesToShow("- Same\n- Same", info);
  expect(shown.map((r) => r.versionId)).toEqual(["v1", "v2"]);
});
