import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { SERVER_EVENTS_PATH } from "@redline/shared";
import type { Store } from "./store.js";

/** Server-sent events: one `data: <ServerEvent JSON>` line per change, so the web UI can refresh live. */
export function registerEventRoutes(app: FastifyInstance, store: Store): void {
  const streams = new Set<ServerResponse>();

  app.addHook("onClose", async () => {
    for (const stream of streams) stream.end();
  });

  app.get(SERVER_EVENTS_PATH, (req, reply) => {
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    stream.write(": connected\n\n");
    streams.add(stream);
    const unsubscribe = store.onChange((event) => stream.write(`data: ${JSON.stringify(event)}\n\n`));
    req.raw.on("close", () => {
      unsubscribe();
      streams.delete(stream);
    });
  });
}
