import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Old title</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
  "notes.md": "# Design\nBlue.",
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

describe("running a thread with the fake engine", () => {
  it("downloads the page, publishes the edits as one thread version, and shows Claude's answer in the thread", async () => {
    let threadId = "";
    const engine = new FakeEngine(() => [
      { type: "step", tool: "Read", summary: "home.html" },
      { edit: { path: "home.html", content: "<!doctype html><h1>New title</h1>" } },
      { replyInThread: { threadId, text: "Done, the title is updated." } },
      { type: "result", summary: "Update the title" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);

    threadId = (await seam.pinThread(page.id, "home.html", "Change the title")).id;
    await seam.waitForVersions(page.id, 2);

    const versions = await seam.versions(page.id);
    expect(versions.map((v) => [v.origin, v.message])).toEqual([
      ["thread", "Update the title"],
      ["creation", "Page created"],
    ]);
    expect(await seam.readFile(page.id, "home.html")).toContain("New title");
    expect(await seam.readFile(page.id, "notes.md")).toBe("# Design\nBlue.");

    const [thread] = (await (await seam.server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(thread.replies.map((r) => [r.author, r.body])).toEqual([["claude", "Done, the title is updated."]]);
  });

  it("gives the session the working copy of the page under .redline/<page>/ and the thread's details", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Make it pop");
    await engine.finished(1);

    const [run] = engine.runs;
    expect(run.workingCopyDir).toBe(join(seam.folder, ".redline", page.id));
    expect(run.resume).toBe(false);
    expect(run.message).toContain(thread.id);
    expect(run.message).toContain("Make it pop");
    expect(run.message).toContain("home.html");
    expect(run.message).toContain(`.redline/${page.id}/`);
    expect(run.filesAtStart).toEqual(PAGE_FILES);
    expect(run.mcpTools).toContain("reply_in_thread");
    expect(readFileSync(join(seam.folder, ".gitignore"), "utf8")).toContain(".redline/");
  });

  it("tells the session which rendering of a responsive artboard the comment was pinned in", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Burger menu", { rendering: { format: "mobile", width: 390 } });
    await engine.finished(1);
    expect(engine.runs[0].message).toContain("vu en Mobile · 390 px");
  });

  it("tells the session which tweak grid cell the comment was pinned in", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Too tight", { cell: { state: "Hover", variant: "Outlined", icon: false } });
    await engine.finished(1);
    expect(engine.runs[0].message).toContain("vu en Hover · Outlined · icon off");
  });

  it("tells the session the state the component instances were in when the comment was written", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Round cross", { instanceState: [{ selector: "main > ui-modal#confirm", attributes: { open: "" } }] });
    await engine.finished(1);
    expect(engine.runs[0].message).toContain("vu avec confirm ouverte");
  });

  it("does not mention a rendering for a comment on a plain artboard", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Plain");
    await engine.finished(1);
    expect(engine.runs[0].message).not.toContain("vu en");
  });

  it("publishes nothing when the run leaves the working copy unchanged", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Is this fine?");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    expect(await seam.versions(page.id)).toHaveLength(1);
  });

  it("publishes nothing when the run fails, even after edits", async () => {
    const engine = new FakeEngine([
      { edit: { path: "home.html", content: "<h1>Half done</h1>" } },
      { type: "error", message: "Subscription limit reached" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Change it");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    expect(await seam.versions(page.id)).toHaveLength(1);
    expect(await seam.readFile(page.id, "home.html")).toContain("Old title");
  });

  it("streams the engine's events to the server as work messages", async () => {
    const engine = new FakeEngine([
      { type: "step", tool: "Read", summary: "home.html" },
      { type: "text", text: "Looking at the title" },
      { type: "result", summary: "Nothing to change" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Look");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    expect(seam.workMessages().map((m) => m.type)).toEqual(["work-event", "work-event", "work-event", "work-done"]);
  });

  it("refuses a reply in a thread that is not part of the running work item", async () => {
    let outcome = "";
    const engine = new FakeEngine(async (run) => {
      outcome = await run.tryReplyInThread("not-a-thread-of-this-run", "sneaky");
      return [{ type: "result", summary: "Nothing to change" }];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Look");
    await engine.finished(1);

    expect(outcome).toMatch(/not part of this run/);
  });

  it("removes a file deleted from the working copy in the published version", async () => {
    const engine = new FakeEngine([{ remove: "notes.md" }, { type: "result", summary: "Drop design notes" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Drop the notes");
    await seam.waitForVersions(page.id, 2);

    expect(existsSync(join(seam.folder, ".redline", page.id, "notes.md"))).toBe(false);
    expect((await seam.server.get(`/api/pages/${page.id}/files/notes.md`)).status).toBe(404);
  });
});

describe("project context in the working copy", () => {
  it("writes DESIGN.md and assets for the session, and no design system folder when the project has none, and never publishes them", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const bytes = Buffer.from([0, 255, 128, 7]);
    const base = `${seam.server.url}/api/projects/${seam.project.id}`;
    await fetch(`${base}/design-md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# Rules" }) });
    await fetch(`${base}/assets/logo.png`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes });
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Check the rules");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    const dir = join(seam.folder, ".redline", page.id);
    expect(readFileSync(join(dir, "DESIGN.md"), "utf8")).toBe("# Rules");
    expect(readFileSync(join(dir, "assets", "logo.png")).equals(bytes)).toBe(true);
    expect(existsSync(join(dir, ".design-system"))).toBe(false);
    expect(engine.runs[0].filesAtStart).toEqual(PAGE_FILES);
    expect(await seam.versions(page.id)).toHaveLength(1);
  });

  it("publishes the assets a session adds or changes to the project, and never deletes one", async () => {
    const hero = Buffer.from([255, 216, 255, 0, 1]);
    const newLogo = Buffer.from([9, 9, 9]);
    const engine = new FakeEngine([
      { edit: { path: "assets/photos/hero.jpg", content: hero } },
      { edit: { path: "assets/logo.png", content: newLogo } },
      { remove: "assets/old.png" },
      { edit: { path: "home.html", content: '<!doctype html><img src="assets/photos/hero.jpg">' } },
      { type: "result", summary: "Add a hero image" },
    ]);
    seam = await startSeam2(engine);
    const base = `${seam.server.url}/api/projects/${seam.project.id}/assets`;
    for (const [name, bytes] of [["logo.png", [1, 2]], ["old.png", [3]], ["kept.png", [4]]] as const) {
      await fetch(`${base}/${name}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(bytes) });
    }
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Add a hero image");
    await seam.waitForWorkEnd();

    const asset = async (name: string) => Buffer.from(await (await fetch(`${seam!.server.artboardOrigin}/pages/${page.id}/assets/${name}`)).arrayBuffer());
    expect((await asset("photos/hero.jpg")).equals(hero)).toBe(true);
    expect((await asset("logo.png")).equals(newLogo)).toBe(true);
    const names = ((await (await fetch(base)).json()) as { name: string }[]).map((a) => a.name).sort();
    expect(names).toEqual(["kept.png", "logo.png", "old.png", "photos/hero.jpg"]);
    expect(await seam.versions(page.id)).toHaveLength(2);
  });

  it("uploads a session's new asset even when no page file changed, without a new version", async () => {
    const engine = new FakeEngine([
      { edit: { path: "assets/font.woff2", content: Buffer.from([1, 2, 3]) } },
      { type: "result", summary: "Add the font" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Add the font");
    await seam.waitForWorkEnd();

    const names = ((await (await fetch(`${seam.server.url}/api/projects/${seam.project.id}/assets`)).json()) as { name: string }[]).map((a) => a.name);
    expect(names).toEqual(["font.woff2"]);
    expect(await seam.versions(page.id)).toHaveLength(1);
    expect(seam.workMessages().at(-1)).toMatchObject({ type: "work-done" });
  });

  it("fails the run with a clear message when a session's asset is over the size limit", async () => {
    const engine = new FakeEngine([
      { edit: { path: "assets/huge.png", content: Buffer.alloc(20 * 1024 * 1024 + 1) } },
      { edit: { path: "home.html", content: "<h1>Changed</h1>" } },
      { type: "result", summary: "Huge" },
    ]);
    seam = await startSeam2(engine, { retryDelaysMs: [] });
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Huge");
    await seam.waitForWorkEnd();

    expect(seam.workMessages().find((m) => m.type === "work-failed")).toMatchObject({ message: expect.stringMatching(/assets\/huge\.png.*20 MB/) });
    expect(await seam.versions(page.id)).toHaveLength(1);
  });
});
