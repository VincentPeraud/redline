import { afterEach, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal } from "./support/terminal.js";

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

it("browser_sign_in answers the url to open in the test browser, then how long it lasts", async () => {
  seam = await startSeam2(new FakeEngine(() => []));
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");

  const answer = await terminal.call("browser_sign_in", { path: "#/projects" });

  expect(answer).toContain(`${seam.server.url}/#/projects`);
  expect(answer).toContain("Open it in the test browser within 60 seconds; the session lasts 30 days.");
});
