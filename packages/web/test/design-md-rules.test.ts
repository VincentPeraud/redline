import { expect, it } from "vitest";
import { ruleOrigins } from "../src/designMdRules.js";

const version = (id: string, content: string, createdAt: string) => ({ id, content, createdAt });

it("lists the bullet lines of DESIGN.md as rules, each with the version that introduced it", () => {
  const versions = [
    version("v3", "# T\n- A\n- B\n- C", "2026-01-03T00:00:00Z"),
    version("v2", "# T\n- A\n- B", "2026-01-02T00:00:00Z"),
    version("v1", "# T\n- A", "2026-01-01T00:00:00Z"),
  ];
  expect(ruleOrigins("# T\n- A\n- B\n- C", versions)).toEqual([
    { rule: "A", createdAt: "2026-01-01T00:00:00Z" },
    { rule: "B", createdAt: "2026-01-02T00:00:00Z" },
    { rule: "C", createdAt: "2026-01-03T00:00:00Z" },
  ]);
});

it("dates a rule from its latest unbroken run, and leaves unsaved rules undated", () => {
  const versions = [
    version("v3", "- A", "2026-01-03T00:00:00Z"),
    version("v2", "- B", "2026-01-02T00:00:00Z"),
    version("v1", "- A", "2026-01-01T00:00:00Z"),
  ];
  expect(ruleOrigins("- A\n- New", versions)).toEqual([
    { rule: "A", createdAt: "2026-01-03T00:00:00Z" },
    { rule: "New", createdAt: undefined },
  ]);
});
