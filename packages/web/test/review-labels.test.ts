import { describe, expect, it } from "vitest";
import { componentsHeading, keptByText, originText, tokensWhereText, whereSummary } from "../src/reviewLabels.js";

describe("review labels", () => {
  it("tells where a change comes from", () => {
    expect(originText({ kind: "direct" })).toBe("fait directement dans le design system");
    expect(originText({ kind: "request", from: ["App · Planning"] })).toBe("demandée par App · Planning");
    expect(originText({ kind: "request", from: ["App · Planning", "Site public · Inscription"] })).toBe("demandée par App · Planning et Site public · Inscription");
    expect(originText({ kind: "comment", from: ["App · Planning"] })).toBe("ton commentaire sur App · Planning");
  });

  it("says which pages a token change reaches, eliding before a vowel", () => {
    expect(tokensWhereText(["App", "Site public"])).toBe("Toutes les pages d’App et de Site public");
    expect(tokensWhereText(["Lumora"])).toBe("Toutes les pages de Lumora");
    expect(tokensWhereText(["Blog", "Cours", "Dons"])).toBe("Toutes les pages de Blog, de Cours et de Dons");
    expect(tokensWhereText([])).toBe("Aucun projet n’utilise encore ce design system");
  });

  it("counts instances and pages", () => {
    expect(whereSummary(12, 6)).toBe("12 instances dans 6 pages de projets");
    expect(whereSummary(1, 1)).toBe("1 instance dans 1 page de projets");
  });

  it("says a project keeps its own component", () => {
    expect(keptByText(["App"], "slot-picker")).toBe("Nulle part : App a déjà son propre ui-slot-picker et le garde");
    expect(keptByText(["App", "Site public"], "picker")).toBe("Nulle part : App et Site public ont déjà leur propre ui-picker et le gardent");
  });

  it("titles the component cards", () => {
    expect(componentsHeading(1)).toBe("1 composant change");
    expect(componentsHeading(3)).toBe("3 composants changent");
  });
});
