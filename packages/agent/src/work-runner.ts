import type { AgentWorkMessage, EngineEvent, WorkItem } from "@redline/shared";
import { uploadChangedAssets } from "./assets.js";
import type { Engine } from "./engine.js";
import { pageAddresses } from "./page-addresses.js";
import { startSessionMcp } from "./session-mcp.js";
import type { ServerApi } from "./server-api.js";
import { designSystemNote } from "./design-system-note.js";
import { readDesignMd, readDesignSystemEdits, readProjectStyle, readWorkingCopy, sameFiles, workingCopyDir, writeWorkingCopy } from "./working-copy.js";

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
    let checkout = await api.checkout(item.pageId);
    const dir = writeWorkingCopy(folder, item.pageId, checkout);
    // Replies are held back until the run succeeded: a retried run must not leave the first attempt's answers in the threads.
    const replies = new Map<string, string[]>();
    let removalsConfirmed = false;
    const mcp = await startSessionMcp({
      api,
      allowedThreadIds: item.threads.map((t) => t.threadId),
      pageId: item.pageId,
      workingCopyDir: dir,
      workId: item.id,
      onRemovalsConfirmed: () => void (removalsConfirmed = true),
      // The page changed under the run: what it publishes is measured against the page as it is now.
      afterArtboardMoved: async () => void (checkout = await api.checkout(item.pageId)),
      postReply: async (threadId, text) => void replies.set(threadId, [...(replies.get(threadId) ?? []), text]),
    });
    let result: EngineEvent | undefined;
    try {
      const request = {
        sessionId: item.sessionId,
        message: `Working copy of the page: .redline/${item.pageId}/ (edit its files; write nowhere else).\n${pageAddresses(api, item.pageId, checkout.files)}\n${designSystemNote(checkout.project)}\n\n${item.message}`,
        cwd: folder,
        workingCopyDir: workingCopyDir(folder, item.pageId),
        mcpUrl: mcp.url,
        model: item.model,
        effort: item.effort,
      };
      for await (const event of item.resume ? engine.resume(request) : engine.start(request)) {
        send({ type: "work-event", workId: item.id, event: event.type === "usage" && item.effort ? { ...event, effort: item.effort } : event });
        if (event.type === "result" || event.type === "error") result = event;
      }
    } finally {
      await mcp.close();
    }
    if (result?.type === "error") throw new Error(result.message);
    if (result?.type !== "result") throw new Error("The engine ended without a result.");

    const baseStyle = checkout.project.projectStyle;
    const files = { ...readWorkingCopy(dir, baseStyle !== undefined), ...readDesignSystemEdits(dir, checkout.project.designSystem?.files) };
    // Assets belong to the project: new or changed ones go up first, so the version that uses them shows them.
    await uploadChangedAssets(api, item.pageId, dir, checkout.project.assets);
    const postReplies = async () => {
      for (const [threadId, texts] of replies) for (const text of texts) await api.replyInThread(threadId, text, item.id);
    };
    // The session may edit DESIGN.md (the rules of the project); a changed one is published with the run.
    const designMd = readDesignMd(dir);
    const designMdChanged = designMd !== undefined && designMd !== checkout.project.designMd;
    const projectStyle = baseStyle === undefined ? undefined : readProjectStyle(dir);
    const projectStyleChanged = projectStyle !== undefined && projectStyle !== baseStyle;
    if (sameFiles(files, checkout.files) && !designMdChanged && !projectStyleChanged) {
      await postReplies();
      return send({ type: "work-done", workId: item.id });
    }
    const version = await api.publish(item.pageId, files, versionMessage(item, result.summary), item.kind === "conversation" ? "conversation" : "thread", checkout.versionId, {
      workId: item.id,
      ...(removalsConfirmed ? { confirmRemovals: true } : {}),
      ...(designMdChanged ? { designMd: { content: designMd, base: checkout.project.designMd } } : {}),
      ...(projectStyleChanged && baseStyle !== undefined ? { projectStyle: { content: projectStyle, base: baseStyle } } : {}),
    });
    await postReplies();
    send({ type: "work-done", workId: item.id, versionId: version.id });
  } catch (error) {
    send({ type: "work-failed", workId: item.id, message: (error as Error).message });
  }
}
