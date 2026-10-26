import {
  AGENT_API_PREFIX,
  artboardHash,
  pageHash,
  playHash,
  type AgentCheckout,
  type AgentGapsRequest,
  type AgentDesignSystem,
  type AgentReplyRequest,
  type CreateSiblingRequest,
  type CreateVersionRequest,
  type MoveArtboardRequest,
  type MoveArtboardResponse,
  type DesignSystem,
  type Page,
  type PageGaps,
  type PageVersionSummary,
  type Project,
  type ProjectAsset,
  type ThreadReply,
  type VersionOrigin,
  type ProjectStyleStart,
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
    extra: Pick<CreateVersionRequest, "workId" | "designMd" | "projectStyle" | "confirmRemovals"> = {},
  ): Promise<PageVersionSummary> {
    const body: CreateVersionRequest = { files, message, origin, baseVersionId, ...extra };
    return this.request("POST", `/pages/${pageId}/versions`, body);
  }

  /** The design system gaps of `files` (a working copy of `pageId`), without the user's exceptions. */
  checkGaps(pageId: string, files: Record<string, string>): Promise<PageGaps> {
    const body: AgentGapsRequest = { files };
    return this.request("POST", `/pages/${pageId}/gaps`, body);
  }

  /** Stores an asset in the project of `pageId`; every artboard of the project reaches it as `assets/<name>`. */
  uploadAsset(pageId: string, name: string, bytes: Buffer): Promise<ProjectAsset> {
    return this.request("PUT", `/pages/${pageId}/assets/${name.split("/").map(encodeURIComponent).join("/")}`, bytes);
  }

  replyInThread(threadId: string, text: string, workId?: string): Promise<ThreadReply> {
    const body: AgentReplyRequest = { body: text, ...(workId ? { workId } : {}) };
    return this.request("POST", `/threads/${threadId}/replies`, body);
  }

  /** Creates an empty page (a manifest, no artboard) in the same project as `pageId`; `workId` ties it to the run that made it. */
  createPageBeside(pageId: string, title: string, workId?: string): Promise<Page> {
    const body: CreateSiblingRequest = { title, ...(workId ? { workId } : {}) };
    return this.request("POST", `/pages/${pageId}/siblings`, body);
  }

  /** Moves an artboard of `pageId` to another page of its project (`targetPageId`), or to a new page (`newPageTitle`). */
  moveArtboard(pageId: string, request: MoveArtboardRequest): Promise<MoveArtboardResponse> {
    return this.request("POST", `/pages/${pageId}/move-artboard`, request);
  }

  listProjects(): Promise<Project[]> {
    return this.request("GET", "/projects");
  }

  createProject(title: string, designSystem?: string): Promise<Project> {
    return this.request("POST", "/projects", { title, ...(designSystem ? { designSystem } : {}) });
  }

  listDesignSystems(): Promise<AgentDesignSystem[]> {
    return this.request("GET", "/design-systems");
  }

  createDesignSystem(title: string): Promise<DesignSystem> {
    return this.request("POST", "/design-systems", { title });
  }

  /** Points the project at a design system, or at none (null; `startFrom` is required when it leaves a shared one). */
  setProjectDesignSystem(projectId: string, designSystem: string | null, startFrom?: ProjectStyleStart): Promise<Project> {
    return this.request("PUT", `/projects/${encodeURIComponent(projectId)}/design-system`, { designSystem, startFrom });
  }

  listPages(projectId: string): Promise<Page[]> {
    return this.request("GET", `/projects/${encodeURIComponent(projectId)}/pages`);
  }

  /** Creates an empty page (a manifest, no artboard) in the project. */
  createPage(projectId: string, title: string): Promise<Page> {
    return this.request("POST", `/projects/${encodeURIComponent(projectId)}/pages`, { title });
  }

  /** Where the user opens a project or a page in the Redline UI. */
  projectUrl(projectId: string): string {
    return `${this.serverUrl}/#/projects/${encodeURIComponent(projectId)}`;
  }

  pageUrl(pageId: string): string {
    return `${this.serverUrl}/${pageHash(pageId)}`;
  }

  artboardUrl(pageId: string, file: string): string {
    return `${this.serverUrl}/${artboardHash(pageId, file)}`;
  }

  playUrl(pageId: string, file: string): string {
    return `${this.serverUrl}/${playHash(pageId, file)}`;
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
