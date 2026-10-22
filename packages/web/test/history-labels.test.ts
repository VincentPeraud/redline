import { describe, expect, it } from "vitest";
import { historyDate, originLabel } from "../src/historyLabels.js";

describe("originLabel", () => {
  it("names the thread or conversation that produced a version", () => {
    expect(originLabel("thread", "Bouton trop discret")).toBe("Fil « Bouton trop discret »");
    expect(originLabel("conversation", "Parcours")).toBe("Conversation « Parcours »");
  });

  it("falls back to the bare kind when the title was not recorded", () => {
    expect(originLabel("thread")).toBe("Fil");
    expect(originLabel("conversation")).toBe("Conversation");
  });

  it("has fixed labels for the other origins", () => {
    expect(originLabel("terminal")).toBe("Terminal");
    expect(originLabel("tweak")).toBe("Tweak");
    expect(originLabel("restore")).toBe("Restauration");
    expect(originLabel("creation")).toBe("Création");
    expect(originLabel("user")).toBe("Toi");
  });
});

describe("historyDate", () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime(); // Thu 22 Oct 2026, 15:00 local
  const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).toISOString();

  it("counts minutes, then hours, within the day", () => {
    expect(historyDate(at(22, 15, 0), { now })).toBe("à l'instant");
    expect(historyDate(at(22, 14, 58), { now })).toBe("il y a 2 min");
    expect(historyDate(at(22, 12, 0), { now })).toBe("il y a 3 h");
  });

  it("says yesterday, with the time on request", () => {
    expect(historyDate(at(21, 16, 40), { now })).toBe("hier");
    expect(historyDate(at(21, 16, 40), { now, withTime: true })).toBe("hier, 16:40");
  });

  it("gives the weekday and date beyond yesterday", () => {
    expect(historyDate(at(20, 9, 0), { now })).toBe("mar. 20 oct.");
  });

  it("adds the year when it is not the current one", () => {
    expect(historyDate(new Date(2025, 11, 3, 9, 0).toISOString(), { now })).toBe("3 déc. 2025");
  });
});
