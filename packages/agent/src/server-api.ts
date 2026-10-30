import {
  AGENT_API_PREFIX,
  BUILD_HASH_HEADER,
  OUTDATED_HEADER,
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
  type TerminalHeartbeatRequest,
  type TerminalReleaseRequest,
  type TerminalPickedPage,
  type TerminalWaitingPage,
  type ThreadReply,
  type VersionOrigin,
  type RenamePageRequest,
  cliUpdateCommand,
} from "@redline/shared";
import { buildHash as ownBuildHash } from "./build-hash.js";

/** The agent's token-guarded view of the server (`/agent-api`); shared by sessions' MCP tools and terminal mode. */
export class ServerApi {
  private serverSaidOutdated = false;

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly buildHash: string = ownBuildHash(),
  ) {}

  /** The server answered, on some call, that this CLI's build differs from its own. */
  get outdated(): boolean {
    return this.serverSaidOutdated;
  }

  updateCommand(): string {
    return cliUpdateCommand(this.serverUrl);
  }

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
    extra: Pick<CreateVersionRequest, "workId" | "designMd" | "projectStyle" | "confirmRemovals" | "terminalSessionId"> = {},
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

  /** Tells the server this terminal session is present (sent at start and then regularly). */
  terminalHeartbeat(sessionId: string, folder: string, machine: string): Promise<void> {
    const body: TerminalHeartbeatRequest = { folder, machine };
    return this.request("POST", `/terminal-sessions/${encodeURIComponent(sessionId)}/heartbeat`, body);
  }

  /** The comments waiting for this terminal session, per page it holds. */
  terminalWaiting(sessionId: string): Promise<TerminalWaitingPage[]> {
    return this.request("GET", `/terminal-sessions/${encodeURIComponent(sessionId)}/waiting`);
  }

  /** Hands one page this terminal session holds (or all of them) over to the agents; answers with what was handed over. */
  terminalRelease(sessionId: string, pageId?: string): Promise<TerminalWaitingPage[]> {
    const body: TerminalReleaseRequest = pageId ? { pageId } : {};
    return this.request("POST", `/terminal-sessions/${encodeURIComponent(sessionId)}/release`, body);
  }

  /** Takes the comments waiting for this terminal session: they leave the waiting list and become its to answer. */
  terminalPick(sessionId: string): Promise<TerminalPickedPage[]> {
    return this.request("POST", `/terminal-sessions/${encodeURIComponent(sessionId)}/pick`, {});
  }

  /** Tells the server this terminal session is closing. */
  terminalBye(sessionId: string): Promise<void> {
    return this.request("POST", `/terminal-sessions/${encodeURIComponent(sessionId)}/bye`, {});
  }

  replyInThread(threadId: string, text: string, workId?: string, terminalSessionId?: string): Promise<ThreadReply> {
    const body: AgentReplyRequest = { body: text, ...(workId ? { workId } : {}), ...(terminalSessionId ? { terminalSessionId } : {}) };
    return this.request("POST", `/threads/${threadId}/replies`, body);
  }

  /** Creates an empty page (a manifest, no artboard) in the same project as `pageId`; `workId` ties it to the run that made it. */
  createPageBeside(pageId: string, title: string, workId?: string): Promise<Page> {
    const body: CreateSiblingRequest = { title, ...(workId ? { workId } : {}) };
    return this.request("POST", `/pages/${pageId}/siblings`, body);
  }

  /** Renames `pageId`; `workId` keeps a session to the pages of its own project. */
  renamePage(pageId: string, title: string, workId?: string): Promise<Page> {
    const body: RenamePageRequest = { title, ...(workId ? { workId } : {}) };
    return this.request("PUT", `/pages/${pageId}/title`, body);
  }

  /** Archives `pageId` (read-only, out of the page lists); `workId` keeps a session to the pages of its own project. */
  archivePage(pageId: string, workId?: string): Promise<Page> {
    return this.request("POST", `/pages/${pageId}/archive`, workId ? { workId } : {});
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

  /** Points the project at a design system, or at none (null). */
  setProjectDesignSystem(projectId: string, designSystem: string | null): Promise<Project> {
    return this.request("PUT", `/projects/${encodeURIComponent(projectId)}/design-system`, { designSystem });
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
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        [BUILD_HASH_HEADER]: this.buildHash,
        ...(body === undefined ? {} : { "content-type": raw ? "application/octet-stream" : "application/json" }),
      },
      body: body === undefined ? undefined : raw ? new Uint8Array(body) : JSON.stringify(body),
    });
    if (res.headers.has(OUTDATED_HEADER)) this.serverSaidOutdated = true;
    if (!res.ok) {
      // A proxy in front of the server may answer with HTML (a 413 from nginx, a 502).
      const error = await res.json().then((body: { error?: string }) => body.error, () => undefined);
      throw new Error(error ?? `The server answered ${res.status} ${res.statusText}`.trim());
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}
