import { useCallback, useEffect, useState } from "react";
import { SESSIONS_PATH, type SessionRow } from "@redline/shared";
import { subscribeServerEvents } from "./serverEvents.js";

/** Sessions of a page's threads and conversations, by thread or conversation id (session id and last activity). */
export function usePageSessions(pageId: string): Map<string, SessionRow> {
  const [sessions, setSessions] = useState<Map<string, SessionRow>>(new Map());

  const refresh = useCallback(async () => {
    const res = await fetch(SESSIONS_PATH);
    const rows = (await res.json()) as SessionRow[];
    setSessions(new Map(rows.filter((row) => row.pageId === pageId).map((row) => [row.id, row])));
  }, [pageId]);

  useEffect(() => {
    void refresh();
    return subscribeServerEvents((event) => {
      if (event.type === "thread-updated" || event.type === "conversation-updated") {
        if (event.pageId === pageId) void refresh();
      } else if (event.type === "run-updated" && event.run.pageId === pageId) {
        void refresh();
      }
    });
  }, [refresh, pageId]);

  return sessions;
}
