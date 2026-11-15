import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Page } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const FILES = {
  "meeting.html": "<!doctype html><h1>Meeting</h1>",
  "plain.html": "<!doctype html><h1>Plain</h1>",
  "tweaks.json": JSON.stringify({ state: "idle" }),
  "manifest.json": JSON.stringify({
    artboards: [
      {
        file: "meeting.html",
        title: "Meeting",
        x: 0,
        y: 0,
        width: 1200,
        height: 800,
        responsive: [
          { format: "desktop", width: 1200, height: 800 },
          { format: "mobile", width: 390, height: 760 },
        ],
      },
      { file: "plain.html", title: "Plain", x: 1300, y: 0, width: 1200, height: 800 },
    ],
    tweaks: [
      { id: "state", type: "choice", label: "State", options: ["idle", "ready", "failed"], artboard: "meeting.html" },
      { id: "dense", type: "toggle", label: "Dense" },
    ],
  }),
};

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const step = (pageId: string, artboard: string, extra: Record<string, unknown> = {}, question = `Is ${artboard} fine?`) => ({ pageId, artboard, changed: `Changed ${artboard}`, lookAt: `Look at ${artboard}`, question, ...extra });
const idOf = (answer: string) => /#\/reviews\/([0-9a-f-]{36})/.exec(answer)![1]!;
const reviewOf = async (id: string) => (await (await seam!.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;

async function start(): Promise<{ terminal: Terminal; page: Page }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const page = await seam.createPage(FILES, "Meeting");
  return { terminal: await openTerminal(seam, stops, "MacBook-Pro"), page };
}

describe("per-step tweaks", () => {
  it("gives the step Claude's values next to the declared tweaks and the saved values, and saves nothing on the page", async () => {
    const { terminal, page } = await start();
    const versionsBefore = (await seam!.versions(page.id)).length;

    const id = idOf(await terminal.call("request_review", { steps: [step(page.id, "meeting.html", { tweaks: { state: "ready", dense: true } })] }));

    const [declared] = (await reviewOf(id)).steps;
    expect(declared).toMatchObject({ tweaks: { state: "ready", dense: true }, savedTweaks: { state: "idle" } });
    expect(declared!.artboardTweaks!.map((tweak) => tweak.id)).toEqual(["state", "dense"]);
    expect(await seam!.versions(page.id)).toHaveLength(versionsBefore);
  });

  it("keeps the same artboard in two steps with different values, and replaces only the step with the same values", async () => {
    const { terminal, page } = await start();
    const id = idOf(await terminal.call("request_review", { steps: [step(page.id, "meeting.html", { tweaks: { state: "ready" } }), step(page.id, "meeting.html", { tweaks: { state: "failed" } })] }));
    expect((await reviewOf(id)).steps).toHaveLength(2);

    await terminal.call("request_review", { steps: [step(page.id, "meeting.html", { tweaks: { state: "failed" } }, "New question?")] });

    const review = await reviewOf(id);
    expect(review.steps.map((s) => [s.tweaks?.state, s.question])).toEqual([
      ["ready", "Is meeting.html fine?"],
      ["failed", "New question?"],
    ]);
  });

  it("refuses an unknown tweak and an invalid value, naming them", async () => {
    const { terminal, page } = await start();

    const unknown = await terminal.call("request_review", { steps: [step(page.id, "meeting.html", { tweaks: { colour: "red" } })] });
    const invalid = await terminal.call("request_review", { steps: [step(page.id, "meeting.html", { tweaks: { state: "missing" } })] });
    const otherArtboard = await terminal.call("request_review", { steps: [step(page.id, "plain.html", { tweaks: { state: "ready" } })] });

    expect(unknown).toMatch(/no tweak "colour"/);
    expect(unknown).toContain("state, dense");
    expect(invalid).toMatch(/tweak "state": value must be one of the options/);
    expect(otherArtboard).toMatch(/no tweak "state"/);
  });

  it("carries the mobile flag, and a step without it stays plain", async () => {
    const { terminal, page } = await start();

    const id = idOf(await terminal.call("request_review", { steps: [step(page.id, "meeting.html", { mobile: true }), step(page.id, "plain.html")] }));

    const [mobile, plain] = (await reviewOf(id)).steps;
    expect(mobile!.mobile).toBe(true);
    expect(plain!.mobile).toBeUndefined();
    expect(plain!.tweaks).toBeUndefined();
  });
});
