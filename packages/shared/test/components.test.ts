import { describe, expect, it } from "vitest";
import { assembleComponents, classesUsedIn, componentClassesOf, componentNameOf, type ComponentPage } from "@redline/shared";

const manifest = (artboards: object[], extra: object = {}) => JSON.stringify({ artboards, ...extra });
const board = (file: string, x: number, y = 0) => ({ file, x, y, width: 200, height: 100 });
const component = (css: string, extra = "") => `<!doctype html><html><head><style data-component>${css}</style>${extra}</head><body></body></html>`;

describe("componentNameOf", () => {
  it("is the file name of an artboard under components/", () => {
    expect(componentNameOf("components/button-primary.html")).toBe("button-primary");
    expect(componentNameOf("components/Button.html")).toBeNull();
    expect(componentNameOf("components/a/b.html")).toBeNull();
    expect(componentNameOf("home.html")).toBeNull();
    expect(componentNameOf("components/button.css")).toBeNull();
  });
});

describe("assembleComponents", () => {
  const pages: ComponentPage[] = [
    {
      id: "p1",
      title: "Forms",
      files: {
        "manifest.json": manifest(
          [board("components/input.html", 300), board("components/button.html", 0), board("home.html", 0, 500)],
          { elements: [{ kind: "title", text: "Actions", x: 0, y: -80, width: 250 }, { kind: "title", text: "Fields", x: 280, y: -80, width: 250 }] },
        ),
        "components/button.html": component(".btn{color:red}", '<meta name="description" content="Main call to action"><template data-usage><button class="btn">OK</button></template>'),
        "components/input.html": component(".input{border:0}"),
        "home.html": component(".home{x:y}"),
      },
    },
    {
      id: "p2",
      title: "Feedback",
      files: {
        "manifest.json": manifest(
          [board("components/badge.html", 0)],
          { tweaks: [{ id: "tone", type: "choice", label: "Tone", options: ["ok", "warn"], artboard: "components/badge.html" }, { id: "other", type: "toggle", label: "Other", artboard: "x.html" }] },
        ),
        "components/badge.html": component(".badge{a:b}"),
      },
    },
  ];

  it("lists components by page then reading order, with page, group title, description, usage and variants", () => {
    const { components } = assembleComponents(pages);
    expect(components.map((c) => [c.name, c.page.id, c.groupTitle])).toEqual([
      ["button", "p1", "Actions"],
      ["input", "p1", "Fields"],
      ["badge", "p2", null],
    ]);
    expect(components[0]).toMatchObject({ file: "components/button.html", description: "Main call to action", usage: '<button class="btn">OK</button>' });
    expect(components[1]).toMatchObject({ description: "", usage: "" });
    expect(components[2].variants.map((t) => t.id)).toEqual(["tone"]);
  });

  it("assembles the style blocks in that order and ignores ordinary artboards", () => {
    expect(assembleComponents(pages).css).toBe(".btn{color:red}\n.input{border:0}\n.badge{a:b}\n");
  });

  it("joins several style blocks of one component", () => {
    const html = `<style data-component>.a{}</style><style>.not{}</style><style data-component>.b{}</style>`;
    const result = assembleComponents([{ id: "p", title: "P", files: { "manifest.json": manifest([board("components/x.html", 0)]), "components/x.html": html } }]);
    expect(result.css).toBe(".a{}\n.b{}\n");
  });

  it("gives a content hash that changes with the file", () => {
    const hashOf = (css: string) => assembleComponents([{ id: "p", title: "P", files: { "manifest.json": manifest([board("components/x.html", 0)]), "components/x.html": component(css) } }]).components[0].hash;
    expect(hashOf("a{}")).toBe(hashOf("a{}"));
    expect(hashOf("a{}")).not.toBe(hashOf("b{}"));
  });

  it("writes one index per page, one line per component", () => {
    const { indexes } = assembleComponents(pages);
    expect(indexes.p1).toBe('## Actions\n- button: Main call to action\n  usage: <button class="btn">OK</button>\n\n## Fields\n- input\n');
    expect(indexes.p2).toBe("- badge\n  variants: tone (Tone: ok, warn)\n");
  });

  it("reports a name used twice, naming both files", () => {
    const dup: ComponentPage[] = [
      { id: "p1", title: "Forms", files: { "manifest.json": manifest([board("components/button.html", 0)]), "components/button.html": component("a{}") } },
      { id: "p2", title: "Feedback", files: { "manifest.json": manifest([board("components/button.html", 0)]), "components/button.html": component("b{}") } },
    ];
    expect(assembleComponents(dup).duplicates).toEqual(['Component "button" is defined twice: components/button.html of page "Forms" and components/button.html of page "Feedback"']);
  });

  it("keeps components of a page without a manifest entry", () => {
    const { components } = assembleComponents([{ id: "p", title: "P", files: { "components/z.html": component("z{}") } }]);
    expect(components.map((c) => c.name)).toEqual(["z"]);
  });
});

describe("component classes", () => {
  it("reads the class selectors of the data-component style blocks only", () => {
    const html = `<style data-component>.btn, .btn-primary:hover { margin: 0.5em; background: url(a.png) }\n@media (min-width: 1px) { .btn.wide > .icon { top: 1.5px } }</style><style>.other{}</style>`;
    expect(componentClassesOf(html).sort()).toEqual(["btn", "btn-primary", "icon", "wide"]);
  });

  it("reads the class names of class attributes", () => {
    const html = `<button class="btn  btn-primary" data-x='1'>a</button><a class='link'>b</a><p classname="no">c</p>`;
    expect([...classesUsedIn(html)].sort()).toEqual(["btn", "btn-primary", "link"]);
  });
});
