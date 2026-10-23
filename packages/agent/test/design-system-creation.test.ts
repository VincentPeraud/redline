import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type ConversationDetail, type DesignSystem, type DesignSystemSummary } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

const tokens = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n}\n`;

describe("design system creation", () => {
  it("from scratch starts a design system project with the core tokens and runs nothing", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const res = await seam.server.post("/api/design-systems", { title: "Fresh" });
    expect(res.status).toBe(201);
    const ds = (await res.json()) as DesignSystem;
    expect(await seam.readFile(ds.pageId, "tokens.css")).toContain("--color-primary");
    expect(engine.runs).toHaveLength(0);
    const list = (await (await seam.server.get("/api/design-systems")).json()) as DesignSystemSummary[];
    expect(list.find((d) => d.id === ds.id)?.usedBy).toEqual([]);
  });

  it("from a project's pages sends Claude those pages and the instructions, served by the project's agent", async () => {
    const engine = new FakeEngine([
      { edit: { path: "tokens.css", content: tokens("#0f766e") } },
      { type: "result", summary: "Derived" },
    ]);
    seam = await startSeam2(engine);
    await seam.createPage({ "home.html": "<h1 style='color:#abcdef'>Brand page</h1>" });
    const res = await seam.server.post("/api/design-systems", {
      title: "Derived",
      fromProjectId: seam.project.id,
      instructions: "Keep it playful",
    });
    expect(res.status).toBe(201);
    const ds = (await res.json()) as DesignSystem;
    await seam.waitForVersions(ds.pageId, 2);
    await seam.waitForWorkEnd(1);

    const message = engine.runs[0].message;
    expect(message).toContain("#abcdef");
    expect(message).toContain("Keep it playful");
    expect(await seam.readFile(ds.pageId, "tokens.css")).toContain("#0f766e");
    const conversations = (await (await seam.server.get(`/api/pages/${ds.pageId}/conversations`)).json()) as { id: string }[];
    const detail = (await (await seam.server.get(`/api/conversations/${conversations[0].id}`)).json()) as ConversationDetail;
    expect(detail.messages[0].body).toBe("Keep it playful");
  });

  it("rejects an unknown source project", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const res = await seam.server.post("/api/design-systems", { title: "X", fromProjectId: "nope" });
    expect(res.status).toBe(404);
  });

  it("lists the projects using each design system", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const ds = (await (await seam.server.post("/api/design-systems", { title: "Brand" })).json()) as DesignSystem;
    await seam.server.post("/api/projects", { title: "Uses it", designSystem: ds.id });
    await seam.server.post("/api/projects", { title: "Does not" });
    const list = (await (await seam.server.get("/api/design-systems")).json()) as DesignSystemSummary[];
    expect(list.find((d) => d.id === ds.id)?.usedBy.map((p) => p.title)).toEqual(["Uses it"]);
  });

  it("lets a design system page be commented on like any page", async () => {
    seam = await startSeam2(new FakeEngine([{ type: "result", summary: "ok" }]));
    const ds = (await (await seam.server.post("/api/design-systems", { title: "Brand" })).json()) as DesignSystem;
    const res = await seam.server.post(`/api/pages/${ds.pageId}/threads`, {
      artboard: "index.html",
      selector: "button",
      xPct: 10,
      yPct: 10,
      body: "Rounder buttons",
    });
    expect(res.status).toBe(201);
  });
});
