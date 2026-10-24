import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Old title</h1><button>Go</button>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

const wholeArtboard = (seam: Seam2, pageId: string, body: string, held = false) =>
  seam.server.post(`/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body, held });

describe("comments on a whole artboard", () => {
  it("reach the session as a comment on the whole artboard, with no element", async () => {
    const engine = new FakeEngine(() => [{ type: "result" as const, summary: "Looked" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = (await (await wholeArtboard(seam, page.id, "Too busy, drop the card")).json()) as Thread;
    await seam.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
    const { message } = engine.runs[0];
    expect(message).toContain(`Comment 1 (thread id: ${thread.id}) on the whole artboard home.html (no specific element):`);
    expect(message).toContain("Too busy, drop the card");
    expect(message).not.toContain("position");
    expect(message).not.toContain("selector");
  });

  it("are described in a batch of held comments next to an element comment", async () => {
    const engine = new FakeEngine(() => [{ type: "result" as const, summary: "Looked" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const element = await seam.pinThread(page.id, "home.html", "Bigger title", { held: true });
    const whole = (await (await wholeArtboard(seam, page.id, "Too busy", true)).json()) as Thread;
    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await seam.waitForWorkEnd(1);

    const { message } = engine.runs[0];
    expect(message).toContain("2 comments on this page");
    expect(message).toContain(`Comment ${element.number} (thread id: ${element.id}) on artboard home.html, element \`h1\``);
    expect(message).toContain(`Comment ${whole.number} (thread id: ${whole.id}) on the whole artboard home.html (no specific element):`);
  });

  it("are documented in the session guide", async () => {
    const { REDLINE_GUIDE } = await import("../src/guide.js");
    expect(REDLINE_GUIDE).toContain("whole artboard");
  });
});
