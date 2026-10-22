import type { AgentWorkMessage, EngineEvent, WorkItem } from "@redline/shared";
import type { Engine } from "./engine.js";
import { startSessionMcp } from "./session-mcp.js";
import type { ServerApi } from "./server-api.js";
import { readWorkingCopy, sameFiles, workingCopyDir, writeWorkingCopy } from "./working-copy.js";

export interface RunContext {
  folder: string;
  api: ServerApi;
  engine: Engine;
  send(message: AgentWorkMessage): void;
}

function versionMessage(item: WorkItem, summary: string): string {
  const firstLine = summary.trim().split("\n")[0].slice(0, 120);
  if (firstLine) return firstLine;
  if (item.kind === "conversation") return "Conversation message";
  return `Answer thread ${item.threads.map((t) => `#${t.number}`).join(", ")}`;
}

/**
 * One run: download the page into `.redline/<page>/`, let the engine work on it, then publish the
 * changed files as a single version. A failed run publishes nothing.
 */
export async function runWorkItem(item: WorkItem, { folder, api, engine, send }: RunContext): Promise<void> {
  try {
    const checkout = await api.checkout(item.pageId);
    const dir = writeWorkingCopy(folder, item.pageId, checkout);
    const mcp = await startSessionMcp({ api, allowedThreadIds: item.threads.map((t) => t.threadId), pageId: item.pageId, workingCopyDir: dir });
    let result: EngineEvent | undefined;
    try {
      const request = {
        sessionId: item.sessionId,
        message: `Working copy of the page: .redline/${item.pageId}/ (edit its files; write nowhere else).\n\n${item.message}`,
        cwd: folder,
        workingCopyDir: workingCopyDir(folder, item.pageId),
        mcpUrl: mcp.url,
        model: item.model,
        effort: item.effort,
      };
      for await (const event of item.resume ? engine.resume(request) : engine.start(request)) {
        send({ type: "work-event", workId: item.id, event });
        if (event.type === "result" || event.type === "error") result = event;
      }
    } finally {
      await mcp.close();
    }
    if (result?.type === "error") throw new Error(result.message);
    if (result?.type !== "result") throw new Error("The engine ended without a result.");

    const files = readWorkingCopy(dir);
    if (sameFiles(files, checkout.files)) return send({ type: "work-done", workId: item.id });
    const version = await api.publish(item.pageId, files, versionMessage(item, result.summary), item.kind);
    send({ type: "work-done", workId: item.id, versionId: version.id });
  } catch (error) {
    send({ type: "work-failed", workId: item.id, message: (error as Error).message });
  }
}
