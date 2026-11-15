import { useEffect, useState } from "react";
import { pageRunsPath, type ThreadRun } from "@redline/shared";
import { subscribeServerEvents } from "./serverEvents.js";

/** Live runs of a page's threads: loaded once (so a reload shows the steps so far), then updated by server events. */
export function useRuns(pageId: string): ThreadRun[] {
  const [runs, setRuns] = useState<ThreadRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    setRuns([]);
    // Runs an event updated while a load was on its way: the event is newer than the loaded copy.
    let heard = new Set<string>();
    // After a cut of the stream, the loaded runs win over the ones held, since the events that ended them may have been missed.
    const load = (afterCut: boolean) => {
      heard = new Set();
      void fetch(pageRunsPath(pageId))
        .then((res) => res.json() as Promise<ThreadRun[]>)
        .then((loaded) => {
          if (cancelled) return;
          const wins = loaded.filter((r) => (afterCut ? !heard.has(r.workId) : true));
          setRuns((current) =>
            afterCut
              ? [...wins, ...current.filter((c) => !wins.some((r) => r.workId === c.workId))]
              : [...loaded.filter((r) => !current.some((c) => c.workId === r.workId)), ...current],
          );
        });
    };
    const unsubscribe = subscribeServerEvents(
      (event) => {
        if (event.type !== "run-updated" || event.run.pageId !== pageId) return;
        heard.add(event.run.workId);
        setRuns((current) => {
          const known = current.some((r) => r.workId === event.run.workId);
          return known ? current.map((r) => (r.workId === event.run.workId ? event.run : r)) : [...current, event.run];
        });
      },
      () => load(true),
    );
    load(false);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [pageId]);

  return runs;
}
