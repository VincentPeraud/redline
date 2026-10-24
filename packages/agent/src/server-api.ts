import {
  AGENT_API_PREFIX,
  type AgentCheckout,
  type AgentReplyRequest,
  type CreateSiblingRequest,
  type CreateVersionRequest,
  type Page,
  type PageVersionSummary,
  type ProjectAsset,
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

  /**
   * Publishes the working copy checked out from `baseVersionId`; the server applies only what changed since then.
   * `workId` lets the server record which thread or conversation made the version; `designMd` carries a changed DESIGN.md.
   */
  publish(
    pageId: string,
    files: Record<string, string>,
    message: string,
    origin: VersionOrigin,
    baseVersionId: string,
    extra: Pick<CreateVersionRequest, "workId" | "designMd"> = {},
  ): Promise<PageVersionSummary> {
    const body: CreateVersionRequest = { files, message, origin, baseVersionId, ...extra };
    return this.request("POST", `/pages/${pageId}/versions`, body);
  }

  /** Stores an asset in the project of `pageId`; every artboard of the project reaches it as `assets/<name>`. */
  uploadAsset(pageId: string, name: string, bytes: Buffer): Promise<ProjectAsset> {
    return this.request("PUT", `/pages/${pageId}/assets/${name.split("/").map(encodeURIComponent).join("/")}`, bytes);
  }

  replyInThread(threadId: string, text: string, workId?: string): Promise<ThreadReply> {
    const body: AgentReplyRequest = { body: text, ...(workId ? { workId } : {}) };
    return this.request("POST", `/threads/${threadId}/replies`, body);
  }

  /** Creates a page (starter files, one artboard) in the same project as `pageId`; `workId` ties it to the run that made it. */
  createPageBeside(pageId: string, title: string, workId?: string): Promise<Page> {
    const body: CreateSiblingRequest = { title, ...(workId ? { workId } : {}) };
    return this.request("POST", `/pages/${pageId}/siblings`, body);
  }

  /** JSON in and out; a Buffer body is sent as raw bytes. */
  private async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(this.serverUrl + AGENT_API_PREFIX + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": raw ? "application/octet-stream" : "application/json" }),
      },
      body: body === undefined ? undefined : raw ? new Uint8Array(body) : JSON.stringify(body),
    });
    if (!res.ok) {
      // A proxy in front of the server may answer with HTML (a 413 from nginx, a 502).
      const error = await res.json().then((body: { error?: string }) => body.error, () => undefined);
      throw new Error(error ?? `The server answered ${res.status} ${res.statusText}`.trim());
    }
    return (await res.json()) as T;
  }
}
