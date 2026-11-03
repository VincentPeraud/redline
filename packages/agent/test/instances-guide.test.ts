import { expect, it } from "vitest";
import { designSystemNote } from "../src/design-system-note.js";
import { REDLINE_GUIDE } from "../src/guide.js";

const section = (title: string) => {
  const start = REDLINE_GUIDE.indexOf(`## ${title}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = REDLINE_GUIDE.indexOf("\n## ", start + 1);
  return REDLINE_GUIDE.slice(start, next === -1 ? undefined : next);
};

it("teaches instances: tag, settings as attributes, slots, defaults", () => {
  const text = section("Component instances");
  expect(text).toContain("<ui-name>");
  expect(text).toContain("A setting is an attribute named after the component's tweak");
  expect(text).toContain("a toggle is a boolean attribute");
  expect(text).toContain("an omitted attribute takes the tweak's default");
  expect(text).toContain('slot="title"');
  expect(text).toContain("the rest goes into the default slot");
  expect(text).toContain(".design-system/pages/<page>.md");
});

it("forbids copying component markup and says what the publish refuses", () => {
  const text = section("Component instances");
  expect(text).toContain("Never copy a component's markup or classes");
  expect(text).toContain("is refused at publish");
  expect(text).toContain("unknown tag");
  expect(text).toContain("unknown setting value");
  expect(text).toContain("slot the component lacks");
});

it("limits styling of an instance to its place and reports the rest as gaps", () => {
  const text = section("Component instances");
  expect(text).toContain("place only");
  expect(text).toContain("width, min-width, max-width, margin, grid-area");
  expect(text).toContain("are reported as gaps");
  expect(text).toContain("a page rule reaching inside an instance");
});

it("explains the wiring attributes opens, closes and toggles and the open attribute", () => {
  const text = section("Component instances");
  expect(text).toContain('opens="<instance id>"');
  expect(text).toContain("closes");
  expect(text).toContain("toggles");
  expect(text).toContain("the open attribute");
  expect(text).toContain("The instance needs an id");
});

it("forbids a page script that changes an instance's look, which Redline does not check", () => {
  const text = section("Component instances");
  expect(text).toContain("Never write a page script that changes how an instance looks");
  expect(text).toContain("Redline does not check it");
});

it("explains the send_request tool and to use the closest instance meanwhile", () => {
  const text = section("Component instances");
  expect(text).toContain("send_request");
  expect(text).toContain("closest instance");
  expect(text).toContain("threadId");
});

it("makes components definitions written with a template, a script and instance-based usage", () => {
  const text = section("Design system and components");
  expect(text).toContain("<template data-component>");
  expect(text).toContain("<script data-component>");
  expect(text).toContain("<ui-");
  expect(text).not.toContain("Show it in the artboard with its markup, so that its classes are the ones to reuse");
  expect(text).not.toContain("reuse its components (their classes, as written in the component file)");
});

it("tells design system sessions that removing a setting value, a slot or changing a default goes through confirm_removals", () => {
  const text = section("Design system and components");
  expect(text).toContain("setting value");
  expect(text).toContain("default");
  expect(text).toContain("confirm_removals");
});

it("the session note says to use instances, never copy markup, and to send a request", () => {
  const note = designSystemNote({
    designMd: "",
    assets: {},
    designSystem: { id: "ds", title: "Brand", diffusion: 2, files: {}, pages: [{ title: "Buttons", components: 1, used: false }] },
  });
  expect(note).toContain("Use its components as instances (<ui-name>");
  expect(note).toContain("never copy their markup");
  expect(note).toContain("send_request");
});
