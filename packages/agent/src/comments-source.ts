import type { TerminalCommentsPage } from "@redline/shared";
import type { CommentsEntry, CommentsFailure } from "./comments-tab.js";
import type { Installation } from "./installations.js";
import { ServerApi } from "./server-api.js";

export interface CommentsResult {
  entries: CommentsEntry[];
  failures: CommentsFailure[];
}

/** Reads, for every installation, the pages whose threads wait for a terminal session. Read-only: nothing is taken (unlike `pending_comments`). */
export async function loadComments(installations: Installation[], read: (installation: Installation) => Promise<TerminalCommentsPage[]> = (installation) => new ServerApi(installation.serverUrl, installation.token).terminalComments()): Promise<CommentsResult> {
  const answers = await Promise.all(
    installations.map((installation) =>
      read(installation).then(
        (pages) => ({ installation, pages }),
        (error: Error) => ({ installation, error }),
      ),
    ),
  );
  const entries: CommentsEntry[] = [];
  const failures: CommentsFailure[] = [];
  for (const answer of answers) {
    const { installation } = answer;
    if ("error" in answer) failures.push({ instance: installation.name, message: /refused|401|403/i.test(answer.error.message) ? "token refused" : "unreachable" });
    else for (const page of answer.pages) entries.push({ instanceId: installation.id, instance: installation.name, serverUrl: installation.serverUrl, page });
  }
  return { entries, failures };
}
