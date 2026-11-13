import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeReview, PageChangeReview } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal } from "./support/terminal.js";

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const step = (pageId: string, artboard: string) => ({ pageId, artboard, changed: `Changed ${artboard}`, lookAt: `Look at ${artboard}`, question: "Fine?" });
const idOf = (answer: string) => /#\/reviews\/([0-9a-f-]{36})/.exec(answer)![1]!;
const bannersOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/change-reviews`)).json()) as PageChangeReview[];
const reviewOf = async (id: string) => (await (await seam!.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;
const send = (method: string, path: string) => fetch(`${seam!.server.url}${path}`, { method });

async function declared(label?: string) {
  seam = await startSeam2(new FakeEngine(() => []));
  const home = await seam.createPage({ "list.html": "<!doctype html><h1>List</h1>", "empty.html": "<!doctype html><h1>Empty</h1>" }, "Home");
  const settings = await seam.createPage({ "settings.html": "<!doctype html><h1>Settings</h1>" }, "Settings");
  const other = await seam.createPage({ "x.html": "<!doctype html><h1>X</h1>" }, "Elsewhere");
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");
  const answer = await terminal.call("request_review", { ...(label ? { label } : {}), steps: [step(home.id, "list.html"), step(home.id, "empty.html"), step(settings.id, "settings.html")] });
  return { reviewId: idOf(answer), home: home.id, settings: settings.id, other: other.id };
}

describe("review banner of a page", () => {
  it("lists the review on every covered page and not on the others", async () => {
    const { reviewId, home, settings, other } = await declared("agora-maquettes");

    const onHome = await bannersOf(home);

    expect(onHome).toHaveLength(1);
    expect(onHome[0]).toMatchObject({ id: reviewId, state: "requested", stepCount: 3, seen: 0, okCount: 0, pageTitles: ["Home", "Settings"], viewerIsRequester: true, requester: { label: "agora-maquettes" } });
    expect(await bannersOf(settings)).toHaveLength(1);
    expect(await bannersOf(other)).toEqual([]);
  });

  it("moves from requested to in progress to finished as the review goes", async () => {
    const { reviewId, home } = await declared();
    const steps = (await reviewOf(reviewId)).steps;

    await send("PUT", `/api/change-reviews/${reviewId}/steps/${steps[0]!.id}/ok`);
    expect((await bannersOf(home))[0]).toMatchObject({ state: "in-progress", seen: 1, okCount: 1 });

    await send("POST", `/api/change-reviews/${reviewId}/finish`);
    expect((await bannersOf(home))[0]).toMatchObject({ state: "finished", seen: 1 });
  });

  it("stacks one banner per review, oldest first", async () => {
    const { reviewId, home } = await declared();
    const terminal = await openTerminal(seam!, stops, "MacBook-Pro");
    const second = idOf(await terminal.call("request_review", { steps: [step(home, "list.html")] }));

    expect((await bannersOf(home)).map((banner) => banner.id)).toEqual([reviewId, second]);
  });

  it("keeps a fetched review for an hour, then drops it", async () => {
    const { reviewId, home } = await declared();
    const db = new Database(join(seam!.server.dataDir, "redline.db"));
    const markFetched = (at: Date) => db.prepare("UPDATE change_reviews SET state = 'fetched', finished_at = ?, fetched_at = ? WHERE id = ?").run(at.toISOString(), at.toISOString(), reviewId);

    markFetched(new Date(Date.now() - 59 * 60_000));
    expect((await bannersOf(home))[0]).toMatchObject({ id: reviewId, state: "fetched" });

    markFetched(new Date(Date.now() - 61 * 60_000));
    expect(await bannersOf(home)).toEqual([]);
    db.close();
  });

  it("broadcasts review changes with the pages they cover", async () => {
    const { reviewId, home, settings } = await declared();
    const steps = (await reviewOf(reviewId)).steps;

    await send("PUT", `/api/change-reviews/${reviewId}/steps/${steps[0]!.id}/ok`);

    await vi.waitFor(() => {
      const updates = seam!.events().filter((event) => event.type === "review-updated");
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates.at(-1)).toMatchObject({ reviewId, pageIds: expect.arrayContaining([home, settings]) });
    });
  });
});
