import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CORE_TOKENS, type AgentTokenResponse, type DesignSystem, type DesignSystemDetail, type Page } from "@redline/shared";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer } from "../src/terminal-mcp.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const tokens = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n}\n`;
const component = (css: string, description = "") =>
  `<!doctype html><html><head><meta name="description" content="${description}"><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (designSystem: string, files: string[]) =>
  JSON.stringify({ designSystem, artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

let seam: Seam2 | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await seam?.stop();
  seam = undefined;
  client = undefined;
});

const send = (method: "PUT" | "PATCH", path: string, body: unknown) =>
  fetch(seam!.server.url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const listVersions = async (id: string) => (await seam!.versions(id)).length;

/** A design system with a "Buttons" page (button, `.btn`) and an empty "Forms" page, diffused once. */
async function designSystemWithButtons(): Promise<{ ds: DesignSystem; buttons: Page }> {
  const ds = (await (await seam!.server.post("/api/design-systems", {
    title: "Acme DS",
    files: {
      "tokens.css": tokens("#111111"),
      "manifest.json": JSON.stringify({ artboards: [{ file: "components/button.html", x: 0, y: 0, width: 200, height: 100 }] }),
      "components/button.html": component(".btn{color:red}", "Main call to action"),
    },
  })).json()) as DesignSystem;
  await send("PUT", `/api/projects/${ds.id}/design-md`, { content: "# Acme rules\n" });
  await send("PATCH", `/api/pages/${ds.pageId}`, { title: "Buttons" });
  await seam!.server.post(`/api/projects/${ds.id}/pages`, { title: "Forms", files: { "manifest.json": JSON.stringify({ artboards: [] }) } });
  await seam!.server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  return { ds, buttons: { id: ds.pageId } as Page };
}

const projectPage = (ds: DesignSystem, html: string) =>
  seam!.createPage({ "index.html": html, "manifest.json": manifestOf(ds.id, ["index.html"]) });

async function connectTerminal(folder: string): Promise<(name: string, args: Record<string, unknown>) => Promise<string>> {
  const { token } = (await (await seam!.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const server = createTerminalMcpServer({ api: new ServerApi(seam!.server.url, token), folder });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "terminal-claude", version: "0.0.0" });
  await client.connect(clientSide);
  return async (name, args) => {
    const result = await client!.callTool({ name, arguments: args });
    return ((result.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
  };
}

describe("a project session's .design-system/ folder", () => {
  it("holds the current diffusion, never the draft, with a per-page index", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Looked" }]);
    seam = await startSeam2(engine);
    const { ds } = await designSystemWithButtons();
    // The draft moves on without a new diffusion.
    await seam.server.post(`/api/pages/${ds.pageId}/versions`, {
      files: {
        "manifest.json": JSON.stringify({ artboards: [{ file: "components/button.html", x: 0, y: 0, width: 200, height: 100 }] }),
        "components/button.html": component(".btn{color:blue}", "Draft wording"),
        "tokens.css": tokens("#999999"),
      },
      message: "Draft change",
      origin: "user",
    });
    await send("PUT", `/api/projects/${ds.id}/design-md`, { content: "# Draft rules\n" });
    const page = await projectPage(ds, '<button class="btn">Go</button>');
    await seam.pinThread(page.id, "index.html", "Look");
    await seam.waitForWorkEnd();

    const dir = join(seam.folder, ".redline", page.id, ".design-system");
    expect(readFileSync(join(dir, "tokens.css"), "utf8")).toContain("#111111");
    expect(readFileSync(join(dir, "DESIGN.md"), "utf8")).toBe("# Acme rules\n");
    expect(readFileSync(join(dir, "components", "button.html"), "utf8")).toContain("color:red");
    const index = readFileSync(join(dir, "index.md"), "utf8");
    expect(index).toContain("Buttons (pages/buttons.md): 1 component");
    expect(index).toContain("Forms (pages/forms.md): 0 components");
    const buttonsPage = readFileSync(join(dir, "pages", "buttons.md"), "utf8");
    expect(buttonsPage).toContain("- button: Main call to action");
    expect(buttonsPage).not.toContain("Draft wording");
    expect(readFileSync(join(dir, "pages", "forms.md"), "utf8")).toContain("No component");
    expect(statSync(join(dir, "tokens.css")).mode & 0o222).toBe(0);
    expect(existsSync(join(seam.folder, ".redline", page.id, "design-system"))).toBe(false);
    expect(Object.keys(engine.runs[0].filesAtStart).sort()).toEqual(["index.html", "manifest.json"]);
  });

  it("is refused when a project session publishes changes to it, and nothing is published", async () => {
    const engine = new FakeEngine([{ edit: { path: ".design-system/components/button.html", content: "<p>mine</p>" } }, { type: "result", summary: "Tried" }]);
    seam = await startSeam2(engine, { retryDelaysMs: [] });
    const { ds } = await designSystemWithButtons();
    const page = await projectPage(ds, "<h1>Home</h1>");
    await seam.pinThread(page.id, "index.html", "Change the button");
    await seam.waitForWorkEnd();

    const failed = seam.workMessages().find((m) => m.type === "work-failed");
    expect(failed).toMatchObject({ message: expect.stringContaining(".design-system/") });
    expect(await listVersions(page.id)).toBe(1);
  });

  it("is refused by the server for any publish carrying design system files", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage({ "index.html": "<h1>Home</h1>" });
    const res = await seam.server.post(`/api/pages/${page.id}/versions`, {
      files: { "index.html": "<h1>Home</h1>", ".design-system/tokens.css": "x" },
      message: "Sneaky",
      origin: "user",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(".design-system/");
  });
});

describe("the session message", () => {
  it("lists the design system pages and the pages the project uses, from component classes", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Looked" }]);
    seam = await startSeam2(engine);
    const { ds } = await designSystemWithButtons();
    const page = await projectPage(ds, '<button class="btn primary">Go</button>');
    await seam.pinThread(page.id, "index.html", "Look");
    await seam.waitForWorkEnd();

    const message = engine.runs[0].message;
    expect(message).toContain("Acme DS");
    expect(message).toContain("Buttons (1 component)");
    expect(message).toContain("Forms (0 components)");
    expect(message).toContain("Ce projet utilise : Buttons");
  });

  it("says when the project uses none", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Looked" }]);
    seam = await startSeam2(engine);
    const { ds } = await designSystemWithButtons();
    const page = await projectPage(ds, '<button class="mine">Go</button>');
    await seam.pinThread(page.id, "index.html", "Look");
    await seam.waitForWorkEnd();

    expect(engine.runs[0].message).toContain("Ce projet n'utilise aucun composant du design system");
    expect(engine.runs[0].message).not.toContain("Ce projet utilise :");
  });

  it("reaches conversations too", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Hello" }]);
    seam = await startSeam2(engine);
    const { ds } = await designSystemWithButtons();
    const page = await projectPage(ds, '<button class="btn">Go</button>');
    const conversation = (await (await seam.server.post(`/api/pages/${page.id}/conversations`, {})).json()) as { id: string };
    await seam.server.post(`/api/conversations/${conversation.id}/messages`, { body: "Hi" });
    await seam.waitForWorkEnd();

    expect(engine.runs[0].message).toContain("Ce projet utilise : Buttons");
  });
});

describe("a design system session", () => {
  async function startDesignSystemSession(script: ConstructorParameters<typeof FakeEngine>[0]) {
    const engine = new FakeEngine(script);
    seam = await startSeam2(engine, { retryDelaysMs: [] });
    const res = await seam.server.post("/api/design-systems", { title: "Derived", fromProjectId: seam.project.id, instructions: "Tune it" });
    const ds = (await res.json()) as DesignSystem;
    await seam.waitForWorkEnd();
    return { engine, ds };
  }

  it("edits the draft's tokens, DESIGN.md and pages, and gets no .design-system/ folder", async () => {
    let seen: { tokens: string; hasFolder: boolean } | undefined;
    const { engine, ds } = await startDesignSystemSession((run) => {
      const dir = run.workingCopyDir;
      seen = { tokens: readFileSync(join(dir, "tokens.css"), "utf8"), hasFolder: existsSync(join(dir, ".design-system")) };
      return [
        { edit: { path: "tokens.css", content: tokens("#0f766e") } },
        { edit: { path: "DESIGN.md", content: "# Rules\n- Rounded\n" } },
        { edit: { path: "components/chip.html", content: component(".chip{}") } },
        { type: "result", summary: "Tuned" },
      ];
    });

    expect(seen?.tokens).toContain("--color-primary");
    expect(seen?.hasFolder).toBe(false);
    expect(engine.runs[0].message).not.toContain("Ce projet utilise");
    expect(Object.keys(engine.runs[0].filesAtStart)).not.toContain("tokens.css");
    expect(((await (await seam!.server.get(`/api/design-systems/${ds.id}/tokens`)).json()) as { content: string }).content).toContain("#0f766e");
    expect(((await (await seam!.server.get(`/api/projects/${ds.id}/design-md`)).json()) as { content: string }).content).toContain("Rounded");
    expect(await seam!.readFile(ds.pageId, "components/chip.html")).toContain(".chip");
    const detail = (await (await seam!.server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
    expect(detail.current.number).toBe(1);
    expect(detail.pending.count).toBeGreaterThan(0);
  });

  it("is refused when a core token is removed from tokens.css", async () => {
    const { ds } = await startDesignSystemSession([{ edit: { path: "tokens.css", content: ":root { --color-primary: red; }" } }, { type: "result", summary: "Broke" }]);
    expect(seam!.workMessages().some((m) => m.type === "work-failed" && m.message.includes("Missing core tokens"))).toBe(true);
    expect(((await (await seam!.server.get(`/api/design-systems/${ds.id}/tokens`)).json()) as { content: string }).content).toContain("--space-unit");
  });
});

describe("publish_page in terminal mode", () => {
  const publishedAnswer = async (html: string, extra: Record<string, string> = {}) => {
    seam = await startSeam2(new FakeEngine([]));
    const { ds } = await designSystemWithButtons();
    const page = await projectPage(ds, "<h1>Home</h1>");
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    const copy = join(seam.folder, ".redline", page.id);
    writeFileSync(join(copy, "index.html"), html);
    for (const [path, content] of Object.entries(extra)) writeFileSync(join(copy, path), content);
    return call("publish_page", { message: "Rework" });
  };

  it("hints when an artboard uses no component class while the design system has components", async () => {
    const answer = await publishedAnswer('<button class="mine">Go</button>');
    expect(answer).toContain("Published version");
    expect(answer).toContain("index.html");
    expect(answer).toContain("component class");
  });

  it("stays silent when the artboard uses a component class", async () => {
    expect(await publishedAnswer('<button class="btn">Go</button>')).not.toContain("component class");
  });

  it("stays silent when the design system has no components", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const ds = (await (await seam.server.post("/api/design-systems", { title: "Bare" })).json()) as DesignSystem;
    const page = await projectPage(ds, "<h1>Home</h1>");
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(seam.folder, ".redline", page.id, "index.html"), "<p>Changed</p>");
    expect(await call("publish_page", { message: "Rework" })).not.toContain("component class");
  });

  it("is never stored: a later checkout and the version history carry no hint", async () => {
    const answer = await publishedAnswer('<button class="mine">Go</button>');
    expect(answer).toContain("component class");
    const pages = (await (await seam!.server.get(`/api/projects/${seam!.project.id}/pages`)).json()) as Page[];
    const versions = await seam!.versions(pages[0].id);
    expect(JSON.stringify(versions)).not.toContain("component class");
  });
});
