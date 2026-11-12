import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in EventSource the test drives: open, a closing error, a ping. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, () => void>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  ping() {
    this.listeners.get("ping")?.();
  }
  /** What a redirect to a sign-in page does: the EventSource gives up for good. */
  failForGood() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const latest = () => FakeEventSource.all[FakeEventSource.all.length - 1];

async function subscribe() {
  const { subscribeServerEvents, STREAM_SILENCE_MS } = await import("../src/serverEvents.js");
  const events: unknown[] = [];
  const resync = vi.fn();
  subscribeServerEvents((event) => events.push(event), resync);
  return { events, resync, STREAM_SILENCE_MS };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeEventSource.all = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("window", { location: { pathname: "/" }, addEventListener: () => {} });
  vi.stubGlobal("navigator", {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the server event stream", () => {
  it("opens the stream again when a proxy closes it for good, and asks the screens to load again once it is back", async () => {
    const { resync } = await subscribe();
    latest().open();
    expect(resync).not.toHaveBeenCalled();
    latest().failForGood();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.all).toHaveLength(2);
    latest().open();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("takes a silent stream for dead and opens it again, but not one that keeps pinging", async () => {
    const { resync, STREAM_SILENCE_MS } = await subscribe();
    latest().open();
    for (let elapsed = 0; elapsed < STREAM_SILENCE_MS * 2; elapsed += 20_000) {
      await vi.advanceTimersByTimeAsync(20_000);
      latest().ping();
    }
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS + STREAM_SILENCE_MS / 4 + 1_000);
    expect(FakeEventSource.all[0].readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.all.length).toBeGreaterThan(1);
    latest().open();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("still hands the events over", async () => {
    const { events } = await subscribe();
    latest().open();
    latest().onmessage?.({ data: JSON.stringify({ type: "page-renamed", pageId: "p1" }) });
    expect(events).toEqual([{ type: "page-renamed", pageId: "p1" }]);
  });
});
