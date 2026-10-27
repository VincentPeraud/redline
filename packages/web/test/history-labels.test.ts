import { describe, expect, it } from "vitest";
import { dayLabel, designMdAuthor, designMdStatus, historyDate, metaLine, originLabel, ruleOrigin } from "../src/historyLabels.js";

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

describe("DESIGN.md authors", () => {
  it("names the author in the header: Claude with its thread or conversation, the terminal, or the user", () => {
    expect(designMdAuthor("thread", "Bouton trop discret")).toBe("Claude · fil « Bouton trop discret »");
    expect(designMdAuthor("conversation", "Écrans plus chaleureux")).toBe("Claude · conversation « Écrans plus chaleureux »");
    expect(designMdAuthor("terminal")).toBe("Terminal");
    expect(designMdAuthor("user")).toBe("toi");
  });

  it("names the origin of a rule, 'création du projet' for the user's first version", () => {
    expect(ruleOrigin("thread", "Calendrier", false)).toBe("Fil « Calendrier »");
    expect(ruleOrigin("conversation", "Parcours", false)).toBe("Conversation « Parcours »");
    expect(ruleOrigin("terminal", undefined, false)).toBe("Terminal");
    expect(ruleOrigin("user", undefined, true)).toBe("Toi · création du projet");
    expect(ruleOrigin("user", undefined, false)).toBe("Toi");
  });
});

describe("signed labels (an SSO is configured)", () => {
  const ariane = { sso: true, name: "Ariane Martin" };
  const nobody = { sso: true };

  it("names the person in a history meta, the requesting person after Claude's thread", () => {
    expect(originLabel("tweak", undefined, ariane)).toBe("Tweak · Ariane Martin");
    expect(originLabel("restore", undefined, { sso: true, name: "Toi" })).toBe("Restauration · Toi");
    expect(originLabel("thread", "Bouton trop discret", ariane)).toBe("Claude · fil « Bouton trop discret », demandé par Ariane Martin");
    expect(originLabel("conversation", "Parcours", ariane, "rule")).toBe("Claude · conversation « Parcours » · demandé par Ariane Martin");
    expect(originLabel("user", undefined, ariane)).toBe("Ariane Martin");
  });

  it("leaves Terminal and records from before the SSO without a name", () => {
    expect(originLabel("terminal", undefined, nobody)).toBe("Terminal");
    expect(originLabel("creation", undefined, nobody)).toBe("Création");
    expect(originLabel("user", undefined, nobody)).toBe("");
    expect(originLabel("thread", "Calendrier", nobody)).toBe("Claude · fil « Calendrier »");
    expect(metaLine(originLabel("user", undefined, nobody), "hier")).toBe("hier");
  });

  it("words the DESIGN.md header and rule origins with the person", () => {
    expect(designMdStatus("user", undefined, "il y a 2 h", ariane)).toBe("Modifié par Ariane Martin · il y a 2 h");
    expect(designMdStatus("thread", "Bouton", "hier", ariane)).toBe("Modifié par Claude · fil « Bouton » · demandé par Ariane Martin · hier");
    expect(designMdStatus("user", undefined, "hier", nobody)).toBe("Modifié · hier");
    expect(designMdStatus("user", undefined, "hier")).toBe("Dernière modification par toi · hier");
    expect(ruleOrigin("user", undefined, true, ariane)).toBe("Ariane Martin · création du projet");
    expect(ruleOrigin("user", undefined, true, nobody)).toBe("Création du projet");
    expect(ruleOrigin("user", undefined, false, nobody)).toBe("");
    expect(ruleOrigin("thread", "Bouton", false, { sso: true, name: "Toi" })).toBe("Claude · fil « Bouton » · demandé par Toi");
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  it("says today, yesterday, or the date", () => {
    expect(dayLabel(new Date(2026, 9, 22, 9, 0).toISOString(), now)).toBe("aujourd'hui");
    expect(dayLabel(new Date(2026, 9, 21, 9, 0).toISOString(), now)).toBe("hier");
    expect(dayLabel(new Date(2026, 9, 20, 9, 0).toISOString(), now)).toBe("mar. 20 oct.");
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
