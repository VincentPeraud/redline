import { useEffect, useState } from "react";
import { pageRunsPath, type ThreadRun } from "@redline/shared";
import { subscribeServerEvents } from "./serverEvents.js";

/** Live runs of a page's threads: loaded once (so a reload shows the steps so far), then updated by server events. */
export function useRuns(pageId: string): ThreadRun[] {
  const [runs, setRuns] = useState<ThreadRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    setRuns([]);
    const unsubscribe = subscribeServerEvents((event) => {
      if (event.type !== "run-updated" || event.run.pageId !== pageId) return;
      setRuns((current) => {
        const known = current.some((r) => r.workId === event.run.workId);
        return known ? current.map((r) => (r.workId === event.run.workId ? event.run : r)) : [...current, event.run];
      });
    });
    void fetch(pageRunsPath(pageId))
      .then((res) => res.json() as Promise<ThreadRun[]>)
      .then((loaded) => {
        if (cancelled) return;
        setRuns((current) => [...loaded.filter((r) => !current.some((c) => c.workId === r.workId)), ...current]);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [pageId]);

  return runs;
}
