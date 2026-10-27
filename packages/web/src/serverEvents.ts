import { SERVER_EVENTS_PATH, type ServerEvent } from "@redline/shared";

// One stream per tab, shared by every subscriber: each EventSource holds one of the browser's six HTTP/1.1 connections to the host,
// so a stream per subscriber starved the page's own requests (they stayed pending).
const handlers = new Set<(event: ServerEvent) => void>();
let source: EventSource | undefined;

/** Calls `handler` for every server event (new version, thread change, agent work). Returns the unsubscribe function. */
export function subscribeServerEvents(handler: (event: ServerEvent) => void): () => void {
  handlers.add(handler);
  if (!source) {
    source = new EventSource(SERVER_EVENTS_PATH);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ServerEvent;
      handlers.forEach((each) => each(event));
    };
  }
  return () => {
    handlers.delete(handler);
    // Closed a tick later: a screen that remounts its subscribers keeps the same stream instead of reconnecting.
    setTimeout(() => {
      if (handlers.size > 0 || !source) return;
      source.close();
      source = undefined;
    });
  };
}
