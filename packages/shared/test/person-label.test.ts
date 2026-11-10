import { describe, expect, it } from "vitest";
import { personLabel, type Person } from "../src/people.js";

const ariane: Person = { id: "amartin", name: "Ariane Martin", email: "a@example.com", initials: "AM" };
const vincent: Person = { id: "vperaud", name: "Vincent Peraud", email: "v@example.com", initials: "VP" };
const nameless: Person = { id: "jdoe", name: "", email: "", initials: "JD" };

describe("personLabel", () => {
  it("says Toi for the viewer's own person and the name for another one, in every place", () => {
    for (const place of ["message", "history", "launcher"] as const) {
      expect(personLabel(vincent, vincent, place)).toBe("Toi");
      expect(personLabel(ariane, vincent, place)).toBe("Ariane Martin");
    }
  });

  it("falls back to the user id for a person without a name", () => {
    expect(personLabel(nameless, vincent, "message")).toBe("jdoe");
  });

  it("names nobody known as Utilisateur inconnu in messages, nothing in histories, a dash in Lancé par", () => {
    expect(personLabel(undefined, vincent, "message")).toBe("Utilisateur inconnu");
    expect(personLabel(undefined, vincent, "history")).toBeUndefined();
    expect(personLabel(undefined, vincent, "launcher")).toBe("—");
  });

  it("keeps today's labels without SSO", () => {
    expect(personLabel(undefined, null, "message")).toBe("Toi");
    expect(personLabel(undefined, null, "history")).toBeUndefined();
  });
});
