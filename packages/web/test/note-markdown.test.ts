import { describe, expect, it } from "vitest";
import { parseNoteMarkdown } from "../src/noteMarkdown.js";

describe("parseNoteMarkdown", () => {
  it("reads bold, italic and links inside a paragraph", () => {
    expect(parseNoteMarkdown("A **bold** and *slanted* [site](https://example.com) word")).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "A " },
          { type: "bold", text: "bold" },
          { type: "text", text: " and " },
          { type: "italic", text: "slanted" },
          { type: "text", text: " " },
          { type: "link", text: "site", href: "https://example.com" },
          { type: "text", text: " word" },
        ],
      },
    ]);
  });

  it("reads bullet lists and joins consecutive lines into one paragraph", () => {
    expect(parseNoteMarkdown("Intro\nmore\n\n- one\n- *two*")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Intro more" }] },
      {
        type: "list",
        items: [[{ type: "text", text: "one" }], [{ type: "italic", text: "two" }]],
      },
    ]);
  });

  it("shows any other markdown as plain text", () => {
    expect(parseNoteMarkdown("# Title\n`code` ![img](https://a.test/a.png)")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "# Title `code` ![img](https://a.test/a.png)" }] },
    ]);
  });

  it("only links http and https addresses", () => {
    expect(parseNoteMarkdown("[x](javascript:alert(1))")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "[x](javascript:alert(1))" }] },
    ]);
  });
});
