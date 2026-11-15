import { afterEach, describe, expect, it } from "vitest";
import { SERVER_EVENTS_PATH } from "@redline/shared";
import { startTestServer, type TestServer } from "../src/test-harness.js";

let server: TestServer;
afterEach(async () => {
  await server.stop();
});

describe("the event stream behind a proxy", () => {
  it("tells proxies not to buffer or transform it", async () => {
    server = await startTestServer();
    const controller = new AbortController();
    const stream = await fetch(server.url + SERVER_EVENTS_PATH, { signal: controller.signal });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.headers.get("cache-control")).toContain("no-transform");
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    controller.abort();
  });

  it("sends a ping while nothing happens, so an idle stream is neither cut nor mistaken for a dead one", async () => {
    server = await startTestServer({ eventsKeepAliveMs: 30 });
    const controller = new AbortController();
    const stream = await fetch(server.url + SERVER_EVENTS_PATH, { signal: controller.signal });
    const reader = stream.body!.getReader();
    let received = "";
    const deadline = Date.now() + 2_000;
    while (!received.includes("event: ping") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(received).toContain("event: ping\ndata: \n\n");
  });
});
