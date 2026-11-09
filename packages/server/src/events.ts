import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { SERVER_EVENTS_PATH, type ServerEvent } from "@redline/shared";
import type { Access, Viewer } from "./access.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

/** The events a link visitor hears of (about its page): the page itself, its design system, its threads. Agent work stays with the team. */
const LINK_EVENTS = new Set<ServerEvent["type"]>(["page-updated", "page-renamed", "page-archive-changed", "design-system-updated", "thread-updated"]);

/** Server-sent events: one `data: <ServerEvent JSON>` line per change, so the web UI can refresh live. Each viewer gets only the events of what they may see. */
export function registerEventRoutes(app: FastifyInstance, store: Store, pageLock: PageLock, access: Access): void {
  const streams = new Set<ServerResponse>();

  app.addHook("onClose", async () => {
    for (const stream of streams) stream.end();
  });

  /** What the viewer may be told of an event: the event itself, a reduced one, or nothing. */
  const visibleTo = (viewer: Viewer, event: ServerEvent): ServerEvent | undefined => {
    const seesPage = (pageId: string | undefined) => (pageId === undefined ? viewer.kind !== "link" : access.may(viewer, "read", { pageId }));
    // An Écriture visitor also hears when agents come and go: it tells whether Claude can answer.
    if (viewer.kind === "link" && !LINK_EVENTS.has(event.type) && !(event.type === "agents-updated" && viewer.link.level === "write")) return undefined;
    if (event.type === "agents-updated") return event;
    if (event.type === "design-system-updated") return { ...event, pageIds: event.pageIds.filter(seesPage) };
    if (event.type === "work") return seesPage(pageLock.itemOf(event.message.workId)?.pageId) ? event : undefined;
    // A project link hears that one of its pages was archived (or put back), though it no longer reaches an archived page: its list changes.
    if (event.type === "page-archive-changed" && viewer.kind === "link" && viewer.link.scope === "project") return store.getPage(event.pageId)?.projectId === viewer.link.scopeId ? event : undefined;
    return seesPage(event.pageId) ? event : undefined;
  };

  app.get(SERVER_EVENTS_PATH, (req, reply) => {
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    stream.write(": connected\n\n");
    streams.add(stream);
    const unsubscribe = store.onChange((event) => {
      const visible = visibleTo(req.viewer, event);
      if (visible) stream.write(`data: ${JSON.stringify(visible)}\n\n`);
    });
    req.raw.on("close", () => {
      unsubscribe();
      streams.delete(stream);
    });
  });
}
