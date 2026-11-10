import { SERVER_EVENTS_PATH, type ServerEvent } from "@redline/shared";
import { API_PREFIX } from "./linkAddress.js";

// One stream for the whole browser, shared by every subscriber of every tab: each EventSource holds one of the browser's
// six HTTP/1.1 connections to the host, so a stream per tab left the seventh tab's requests pending forever.
// The tab holding the lock opens the stream and relays its events to the other tabs; when it closes, the lock passes on.
// A tab keeps its part for its whole life: handing the stream over on every screen change would drop the events
// sent while the next tab connects (the server never replays them).
const LOCK_NAME = "redline-server-events";
const CHANNEL_NAME = "redline-server-events";

const handlers = new Set<(event: ServerEvent) => void>();
let started = false;

const dispatch = (event: ServerEvent) => handlers.forEach((each) => each(event));

function openStream(onEvent: (event: ServerEvent) => void): void {
  const source = new EventSource(`${API_PREFIX}${SERVER_EVENTS_PATH}`);
  source.onmessage = (message) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(message.data) as ServerEvent;
    } catch {
      return;
    }
    onEvent(event);
  };
}

function startStream(): void {
  // Web Locks only exist in secure contexts (https, localhost): elsewhere each tab keeps its own stream.
  if (!navigator.locks || API_PREFIX !== "") return openStream(dispatch);
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (message: MessageEvent<ServerEvent>) => dispatch(message.data);
  // Held until the tab closes, which releases the lock for the next tab waiting for it.
  void navigator.locks.request(LOCK_NAME, () => {
    openStream((event) => {
      // Relayed first, so a throwing handler of this tab can't keep the event from the others.
      channel.postMessage(event);
      dispatch(event);
    });
    return new Promise<never>(() => {});
  });
}

/** Calls `handler` for every server event (new version, thread change, agent work). Returns the unsubscribe function. */
export function subscribeServerEvents(handler: (event: ServerEvent) => void): () => void {
  handlers.add(handler);
  if (!started) {
    started = true;
    startStream();
  }
  return () => {
    handlers.delete(handler);
  };
}
