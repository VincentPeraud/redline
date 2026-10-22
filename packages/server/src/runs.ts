import type { FastifyInstance } from "fastify";
import { pageRunsPath, type ServerEvent, type ThreadRun } from "@redline/shared";
import type { Store } from "./store.js";

/**
 * Follows what agents report about work items and keeps the live state of each run in memory
 * (status, steps, streamed text), so a reloaded browser sees what happened so far. Returns the runs by work id, oldest first.
 */
export function registerRunRoutes(app: FastifyInstance, store: Store): Map<string, ThreadRun> {
  const runs = new Map<string, ThreadRun>();

  function update(workId: string, change: (run: ThreadRun) => void): void {
    const run = runs.get(workId);
    if (!run) return;
    change(run);
    store.emit({ type: "run-updated", pageId: run.pageId, run: structuredClone(run) });
  }

  const unsubscribe = store.onChange((event: ServerEvent) => {
    if (event.type === "work-dispatched") {
      const run: ThreadRun = { workId: event.workId, pageId: event.pageId, threadIds: event.threadIds, status: "sent", steps: [], text: "" };
      runs.set(event.workId, run);
      store.emit({ type: "run-updated", pageId: run.pageId, run: structuredClone(run) });
      return;
    }
    if (event.type === "work-retrying") {
      update(event.workId, (run) => {
        run.status = "retrying";
        run.error = event.message;
        run.retryAt = event.retryAt;
        run.limit = event.limit;
      });
      return;
    }
    if (event.type !== "work") return;
    const message = event.message;
    if (message.type === "work-event") {
      const { event: engineEvent } = message;
      if (engineEvent.type === "step") {
        update(message.workId, (run) => {
          run.status = "running";
          run.steps.push({ tool: engineEvent.tool, summary: engineEvent.summary });
        });
      } else if (engineEvent.type === "text") {
        update(message.workId, (run) => {
          run.status = "running";
          run.text += engineEvent.text;
        });
      }
    } else if (message.type === "work-done") {
      update(message.workId, (run) => {
        run.status = "answered";
      });
    } else {
      // The lock announces a retry (`work-retrying`) before this very `work-failed` reaches us; that run is not failed.
      if (runs.get(message.workId)?.status === "retrying") return;
      update(message.workId, (run) => {
        run.status = "failed";
        run.error = message.message;
      });
    }
  });
  app.addHook("onClose", async () => unsubscribe());

  app.get<{ Params: { pageId: string } }>(pageRunsPath(":pageId"), async (req) =>
    [...runs.values()].filter((run) => run.pageId === req.params.pageId),
  );
  return runs;
}
