import {
  AGENT_API_PREFIX,
  type AgentCheckout,
  type CreateReplyRequest,
  type CreateVersionRequest,
  type Page,
  type PageType,
  type PageVersionSummary,
  type ThreadReply,
  type VersionOrigin,
} from "@redline/shared";

/** The agent's token-guarded view of the server (`/agent-api`); shared by sessions' MCP tools and terminal mode. */
export class ServerApi {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
  ) {}

  checkout(pageId: string): Promise<AgentCheckout> {
    return this.request("GET", `/pages/${pageId}/files`);
  }

  /** Publishes the working copy checked out from `baseVersionId`; the server applies only what changed since then. */
  publish(pageId: string, files: Record<string, string>, message: string, origin: VersionOrigin, baseVersionId: string): Promise<PageVersionSummary> {
    const body: CreateVersionRequest = { files, message, origin, baseVersionId };
    return this.request("POST", `/pages/${pageId}/versions`, body);
  }

  replyInThread(threadId: string, text: string): Promise<ThreadReply> {
    const body: CreateReplyRequest = { body: text };
    return this.request("POST", `/threads/${threadId}/replies`, body);
  }

  /** Creates a page (starter files) in the same project as `pageId`. */
  createPageBeside(pageId: string, title: string, type: PageType): Promise<Page> {
    return this.request("POST", `/pages/${pageId}/siblings`, { title, type });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.serverUrl + AGENT_API_PREFIX + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
    return (await res.json()) as T;
  }
}
