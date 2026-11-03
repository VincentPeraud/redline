import { describe, expect, it } from "vitest";
import { instanceStateLabel, instanceStateText } from "../src/index.js";

describe("instance state wording", () => {
  it("names an instance by its id, else its tag, followed by what it was doing", () => {
    expect(instanceStateText({ selector: "main > ui-modal#confirm", attributes: { open: "" } })).toBe("confirm ouverte");
    expect(instanceStateText({ selector: "main > ui-tabs", attributes: { selected: "" } })).toBe("ui-tabs sélectionnée");
    expect(instanceStateText({ selector: "ui-modal#confirm >>> div > ui-button:nth-of-type(2)", attributes: { size: "lg", open: "" } })).toBe("ui-button size lg, ouverte");
  });

  it("joins several instances", () => {
    expect(
      instanceStateLabel([
        { selector: "ui-modal#confirm", attributes: { open: "" } },
        { selector: "ui-drawer#menu", attributes: { open: "" } },
      ]),
    ).toBe("confirm ouverte, menu ouverte");
  });
});
