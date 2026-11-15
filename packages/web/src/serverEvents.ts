import { SERVER_EVENTS_PATH, type ServerEvent } from "@redline/shared";
import { API_PREFIX } from "./linkAddress.js";

// One stream for the whole browser, shared by every subscriber of every tab: each EventSource holds one of the browser's
// six HTTP/1.1 connections to the host, so a stream per tab left the seventh tab's requests pending forever.
// The tab holding the lock opens the stream and relays its events to the other tabs; when it closes, the lock passes on.
// A tab keeps its part for its whole life: handing the stream over on every screen change would drop the events
// sent while the next tab connects (the server never replays them).
// The relayed messages changed shape (v2: an event or a resync): a tab of an older build, until it reloads, keeps to the old names.
const LOCK_NAME = "redline-server-events-v2";
const CHANNEL_NAME = "redline-server-events-v2";
/** A tab that gets the lock later than this took the stream over from a closed tab: events may have been missed meanwhile. */
const TAKEOVER_AFTER_MS = 500;

/** Without an event or a ping for this long, the stream is taken for dead and opened again (the server pings every 25 s). */
export const STREAM_SILENCE_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

const handlers = new Set<(event: ServerEvent) => void>();
const resyncs = new Set<() => void>();
let started = false;

const dispatch = (event: ServerEvent) => handlers.forEach((each) => each(event));
const dispatchResync = () => resyncs.forEach((each) => each());

/** What the tab holding the stream relays to the others: an event, or "the stream was down, load everything again". */
type Relayed = { event: ServerEvent } | { resync: true };

/**
 * Keeps one EventSource open for good. A proxy (an SSO in front of Redline) may cut it, or answer a reconnection with a redirect,
 * which closes an EventSource for good; a sleeping laptop may leave it silently dead. It is then opened again, and once it is back,
 * `onResync` tells the screens to load their data again, since the server never replays the events sent meanwhile.
 */
function openStream(onEvent: (event: ServerEvent) => void, onResync: () => void, { tookOver = false }: { tookOver?: boolean } = {}): void {
  let source: EventSource | undefined;
  let lastHeard = Date.now();
  let failures = 0;
  // A tab taking the stream over catches up from its first opening; otherwise the screens have just loaded their data.
  let opened = tookOver;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const reopen = () => {
    source?.close();
    clearTimeout(retry);
    retry = setTimeout(connect, RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]);
    failures++;
  };

  function connect(): void {
    lastHeard = Date.now();
    const current = new EventSource(`${API_PREFIX}${SERVER_EVENTS_PATH}`);
    source = current;
    current.onopen = () => {
      lastHeard = Date.now();
      failures = 0;
      // The first opening has nothing to catch up on; every later one may have missed events.
      if (opened) onResync();
      opened = true;
    };
    current.addEventListener("ping", () => {
      lastHeard = Date.now();
    });
    current.onmessage = (message) => {
      lastHeard = Date.now();
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data) as ServerEvent;
      } catch {
        return;
      }
      onEvent(event);
    };
    // A closed EventSource does not retry by itself (an error answer, a redirect to a sign-in page): it is opened again here.
    current.onerror = () => {
      if (current.readyState === EventSource.CLOSED && source === current) reopen();
    };
  }

  connect();
  setInterval(() => {
    if (source?.readyState !== EventSource.CLOSED && Date.now() - lastHeard > STREAM_SILENCE_MS) reopen();
  }, STREAM_SILENCE_MS / 4);
  // Back online: a stream that is closed or silent is opened again at once; a healthy one is left alone.
  window.addEventListener("online", () => {
    if (source?.readyState === EventSource.OPEN && Date.now() - lastHeard <= STREAM_SILENCE_MS / 2) return;
    failures = 0;
    reopen();
  });
}

function startStream(): void {
  // Web Locks only exist in secure contexts (https, localhost): elsewhere each tab keeps its own stream.
  if (!navigator.locks || API_PREFIX !== "") return openStream(dispatch, dispatchResync);
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (message: MessageEvent<Relayed>) => ("resync" in message.data ? dispatchResync() : dispatch(message.data.event));
  const asked = Date.now();
  // Held until the tab closes, which releases the lock for the next tab waiting for it.
  void navigator.locks.request(LOCK_NAME, () => {
    openStream(
      (event) => {
        // Relayed first, so a throwing handler of this tab can't keep the event from the others.
        channel.postMessage({ event } satisfies Relayed);
        dispatch(event);
      },
      () => {
        channel.postMessage({ resync: true } satisfies Relayed);
        dispatchResync();
      },
      { tookOver: Date.now() - asked > TAKEOVER_AFTER_MS },
    );
    return new Promise<never>(() => {});
  });
}

/**
 * Calls `handler` for every server event (new version, thread change, agent work), and `resync` when the stream comes back after
 * a cut: events may have been missed, so it loads again what the screen shows. Returns the unsubscribe function.
 */
export function subscribeServerEvents(handler: (event: ServerEvent) => void, resync?: () => void): () => void {
  handlers.add(handler);
  if (resync) resyncs.add(resync);
  if (!started) {
    started = true;
    startStream();
  }
  return () => {
    handlers.delete(handler);
    if (resync) resyncs.delete(resync);
  };
}
