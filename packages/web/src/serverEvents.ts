import { SERVER_EVENTS_PATH, type ServerEvent } from "@redline/shared";

/** Calls `handler` for every server event (new version, thread change, agent work). Returns the unsubscribe function. */
export function subscribeServerEvents(handler: (event: ServerEvent) => void): () => void {
  const source = new EventSource(SERVER_EVENTS_PATH);
  source.onmessage = (message) => handler(JSON.parse(message.data) as ServerEvent);
  return () => source.close();
}
