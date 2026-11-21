import type { FastifyInstance } from "fastify";
import {
  AGENT_API_PREFIX,
  BUILD_HASH_HEADER,
  OUTDATED_HEADER,
  DESIGN_MD_PATH,
  DESIGN_SYSTEM_TOKENS_PATH,
  PROJECT_STYLE_PATH,
  MAX_ASSET_BYTES,
  folderName,
  type AccessLevel,
  type AgentCheckout,
  type ChangeReviewFeedbackRequest,
  type RequestChangeReviewRequest,
  type AgentGapsRequest,
  type AgentReplyRequest,
  type AgentReplyResponse,
  type CreateSiblingRequest,
  type HandOverCommentsRequest,
  type CreateVersionRequest,
  type TerminalHeartbeatRequest,
  type TerminalCommentsPage,
  type TakeCommentsRequest,
  type TakeCommentsResponse,
  type CommentsOverview,
  type CommentsReminder,
  type RememberPageRequest,
  type ReleaseCommentsRequest,
  type ReleaseCommentsResponse,
  type MoveArtboardRequest,
  type RenamePageRequest,
  type MergeRequestRequest,
  type SendRequestRequest,
  type DesignMdAuthor,
  starterDesignSystemFiles,
  starterPageFiles,
  type AgentDesignSystem,
  HOST_PROTOCOL_VERSION,
  type RedlineInstanceResponse,
  type ServerConfig,
} from "@redline/shared";
import { manifestTitleError, mergeOntoCurrent } from "./publish.js";
import { agentGaps } from "./gaps.js";
import { moveArtboard } from "./move-artboard.js";
import { sendRequest } from "./requests.js";
import { askToUndoRefused } from "./refusals.js";
import { settleUndoneChanges } from "./undone-changes.js";
import { watchDraftRemovals } from "./draft-removals.js";
import { changesError, mergeRequests } from "./change-records.js";
import { ARCHIVED_PAGE_ERROR, archivableExists, archivePage, archiveProject, archivedError, projectOrDesignSystem } from "./archive.js";
import { accountLevelIn, type Access, type Viewer } from "./access.js";
import { versionComponentsError } from "./components.js";
import { removalsError } from "./removals.js";
import { instanceChangesError } from "./instance-guards.js";
import { crossPageReferencesError } from "./cross-page-references.js";
import { MAX_TERMINAL_TEXT_LENGTH, isTerminalSessionId, requiredString, titleError, tokensError, versionRequestError } from "./validation.js";
import { projectContext, putProjectAsset } from "./project-files.js";
import { designSystemChangeError } from "./project-design-system.js";
import { switchDesignSystem } from "./switch-design-system.js";
import { changeReviewFeedback, declareChangeReview } from "./change-reviews.js";
import type { PageLock } from "./page-lock.js";
import type { TerminalSessions } from "./terminal-sessions.js";
import { replyFromConversation } from "./conversation-replies.js";
import { archivedRefusal, commentsOverview, commentsToTake, releaseComments, remindersOf, takePage, takeThreads, type TakeEnv } from "./comment-takes.js";
import { writeRefusal } from "./write-refusal.js";
import { nameOf } from "./person-name.js";
import { handOverPage } from "./hand-over.js";
import type { OriginRef, Store } from "./store.js";

/** The thread or conversation a running work item answers, as version/DESIGN.md origin; none when the item is unknown or belongs to another page. */
export function workOrigin(store: Store, pageLock: PageLock, workId: unknown, pageId: string): (OriginRef & { kind: "thread" | "conversation" }) | undefined {
  const item = typeof workId === "string" ? pageLock.itemOf(workId) : undefined;
  if (!item || item.pageId !== pageId) return undefined;
  if (item.conversationId) {
    const conversation = store.getConversation(item.conversationId);
    const person = pageLock.requesterOf(item.id);
    return { kind: "conversation", originId: item.conversationId, ...(conversation ? { originLabel: conversation.title } : {}), ...(person ? { person } : {}) };
  }
  const first = item.threads[0] && store.getThread(item.threads[0].threadId);
  const person = pageLock.requesterOf(item.id);
  return first ? { kind: "thread", originId: first.id, originLabel: first.title, ...(person ? { person } : {}) } : undefined;
}

/** HTTP API for agents and their sessions' MCP tools, guarded by the agent token (see `AGENT_API_PREFIX`). */
export async function registerAgentApi(app: FastifyInstance, store: Store, pageLock: PageLock, terminalSessions: TerminalSessions, access: Access, config: ServerConfig, publicUrl?: string): Promise<void> {
  const signInLinkTimes = new Map<string, number[]>();
  /** A running work item (`workId`) that does not belong to `projectId`, or whose run is over: its session may not act there. */
  const workOutsideProject = (workId: unknown, projectId: string | undefined): boolean => {
    if (workId === undefined) return false;
    const workPage = typeof workId === "string" ? pageLock.itemOf(workId)?.pageId : undefined;
    return workPage === undefined || store.getPage(workPage)?.projectId !== projectId;
  };
  await app.register(
    async (api) => {
      // onRequest, not preHandler: a wrong token is refused before its body (up to 20 MB for assets) is read.
      api.addHook("onRequest", async (req, reply) => {
        const given = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice("Bearer ".length) : undefined;
        if (!store.accounts.agentActorOf(given)) {
          return reply.code(401).send({ error: "Wrong or missing agent token." });
        }
        const build = req.headers[BUILD_HASH_HEADER];
        if (typeof build === "string" && store.isOutdated(build)) reply.header(OUTDATED_HEADER, "1");
      });

      api.addHook("preHandler", async (req, reply) => {
        const { sessionId } = (req.params ?? {}) as { sessionId?: string };
        if (sessionId !== undefined && !isTerminalSessionId(sessionId)) return reply.code(400).send({ error: "a terminal session id is a UUID" });
        if (sessionId !== undefined && !terminalSessions.claim(sessionId, req.viewer.kind === "agent" ? req.viewer.person?.id : undefined)) {
          return reply.code(403).send({ error: "this terminal session belongs to another account" });
        }
      });

      // Terminal mode (`redline mcp`) says it is there: every ~20 s while the session is open, and once more as it closes.
      api.post<{ Params: { sessionId: string }; Body: Partial<TerminalHeartbeatRequest> }>("/terminal-sessions/:sessionId/heartbeat", async (req, reply) => {
        const { folder, machine } = req.body ?? {};
        if (!requiredString(folder) || !requiredString(machine)) return reply.code(400).send({ error: "folder and machine are required" });
        if (folder.length > MAX_TERMINAL_TEXT_LENGTH || machine.length > MAX_TERMINAL_TEXT_LENGTH) return reply.code(400).send({ error: `folder and machine are ${MAX_TERMINAL_TEXT_LENGTH} characters at most` });
        terminalSessions.heartbeat(req.params.sessionId, folder, machine, req.viewer.kind === "agent" ? req.viewer.person?.id : undefined);
        return reply.code(204).send();
      });

      const notConnected = "this terminal session is not connected to Redline (it never sent its heartbeat, or lost it): restart or reconnect the terminal";

      // The agents screen's Comments tab: every page with threads to take, read-only (unlike `take`, it takes nothing).
      api.get("/terminal-comments", async (req): Promise<TerminalCommentsPage[]> => commentsToTake(store, (projectId) => access.may(req.viewer, "read", { projectId })));

      // An agent token only reaches where its person writes (`levelOf` says nothing else), so the refusal reads the person's real level.
      const realLevelOf = (req: { viewer: Viewer }, projectId: string): AccessLevel | undefined =>
        req.viewer.kind === "agent" && req.viewer.person ? accountLevelIn(store, { id: req.viewer.person.id, role: req.viewer.role }, projectId) : access.levelOf(req.viewer, { projectId });
      const takeEnv = (req: { viewer: Viewer }): TakeEnv => ({ store, pageLock, levelOf: (projectId) => realLevelOf(req, projectId) });
      const refusalOf = (req: { viewer: Viewer }, accountId: string, projectId: string) => writeRefusal(store, accountId, realLevelOf(req, projectId), projectId);

      // `pending_comments`: with a page, the account takes its threads to take and is given them with the ones it already took; with thread ids, it takes those
      // (and takes over another account's with `takeOver`); with neither, the projects' waiting threads are only listed.
      api.post<{ Params: { sessionId: string }; Body: Partial<TakeCommentsRequest> }>("/terminal-sessions/:sessionId/take", async (req, reply): Promise<TakeCommentsResponse | CommentsOverview | void> => {
        const label = terminalSessions.labelOf(req.params.sessionId);
        if (!label) return reply.code(403).send({ error: notConnected });
        const { pageId, threadIds, takeOver, projectIds } = req.body ?? {};
        if (pageId !== undefined && !requiredString(pageId)) return reply.code(400).send({ error: "pageId must be a page id" });
        if (threadIds !== undefined && (!Array.isArray(threadIds) || threadIds.length === 0 || !threadIds.every((id) => requiredString(id)))) return reply.code(400).send({ error: "threadIds must be a list of thread ids" });
        if (takeOver !== undefined && typeof takeOver !== "boolean") return reply.code(400).send({ error: "takeOver must be a boolean" });
        if (projectIds !== undefined && (!Array.isArray(projectIds) || !projectIds.every((id) => requiredString(id)))) return reply.code(400).send({ error: "projectIds must be a list of project ids" });
        if (pageId !== undefined && threadIds !== undefined) return reply.code(400).send({ error: "give a pageId or threadIds, not both" });
        if (pageId !== undefined) {
          const projectId = store.projectIdOfPage(pageId);
          if (!projectId) return reply.code(404).send({ error: "page not found" });
          const refusal = refusalOf(req, label.accountId, projectId);
          if (refusal) return reply.code(403).send({ error: refusal });
          const archived = archivedRefusal(store, pageId);
          if (archived) return reply.code(409).send({ error: archived });
          return takePage(takeEnv(req), label, pageId);
        }
        if (threadIds !== undefined) return takeThreads(takeEnv(req), label, threadIds, takeOver === true);
        return commentsOverview(takeEnv(req), label, projectIds ?? []);
      });

      // `release_comments`: the account lets go of its takes; the threads follow their page's mode again.
      api.post<{ Params: { sessionId: string }; Body: Partial<ReleaseCommentsRequest> }>("/terminal-sessions/:sessionId/release", async (req, reply): Promise<ReleaseCommentsResponse | void> => {
        const label = terminalSessions.labelOf(req.params.sessionId);
        if (!label) return reply.code(403).send({ error: notConnected });
        const { pageId, threadIds } = req.body ?? {};
        if (pageId !== undefined && !requiredString(pageId)) return reply.code(400).send({ error: "pageId must be a page id" });
        if (threadIds !== undefined && (!Array.isArray(threadIds) || !threadIds.every((id) => requiredString(id)))) return reply.code(400).send({ error: "threadIds must be a list of thread ids" });
        if ((pageId === undefined) === (threadIds === undefined)) return reply.code(400).send({ error: "give a pageId or threadIds" });
        if (pageId !== undefined && !store.getPage(pageId)) return reply.code(404).send({ error: "page not found" });
        const archived = pageId === undefined ? undefined : archivedRefusal(store, pageId);
        if (archived) return reply.code(409).send({ error: archived });
        return releaseComments(takeEnv(req), label, { pageId, threadIds });
      });

      // This conversation published or checked out the page: its folder's reminder line is about the pages it knows.
      api.post<{ Params: { sessionId: string }; Body: Partial<RememberPageRequest> }>("/terminal-sessions/:sessionId/pages", async (req, reply) => {
        const label = terminalSessions.labelOf(req.params.sessionId);
        if (!label) return reply.code(403).send({ error: notConnected });
        const { pageId } = req.body ?? {};
        if (!requiredString(pageId) || !store.getPage(pageId)) return reply.code(404).send({ error: "page not found" });
        store.rememberTerminalPage(label.accountId, label.folder, pageId);
        return reply.code(204).send();
      });

      api.get<{ Params: { sessionId: string } }>("/terminal-sessions/:sessionId/reminder", async (req, reply): Promise<CommentsReminder | void> => {
        const label = terminalSessions.labelOf(req.params.sessionId);
        if (!label) return reply.code(403).send({ error: notConnected });
        return remindersOf(takeEnv(req), label);
      });

      // `request_review` and `review_feedback`: a terminal session declares a review of its changes, then reads its result.
      api.post<{ Params: { sessionId: string }; Body: Partial<RequestChangeReviewRequest> }>("/terminal-sessions/:sessionId/reviews", async (req, reply) => {
        if (!terminalSessions.isPresent(req.params.sessionId)) return reply.code(403).send({ error: notConnected });
        const result = declareChangeReview({ store, access }, req.viewer, { id: req.params.sessionId, folder: terminalSessions.folderOf(req.params.sessionId) }, req.body);
        return "error" in result ? reply.code(result.status).send({ error: result.error }) : reply.code(201).send(result);
      });

      api.post<{ Params: { sessionId: string }; Body: Partial<ChangeReviewFeedbackRequest> }>("/terminal-sessions/:sessionId/review-feedback", async (req, reply) => {
        if (!terminalSessions.isPresent(req.params.sessionId)) return reply.code(403).send({ error: notConnected });
        const { reviewId, projectIds, takeOver } = req.body ?? {};
        if (reviewId !== undefined && !requiredString(reviewId)) return reply.code(400).send({ error: "reviewId must be a review id" });
        if (projectIds !== undefined && (!Array.isArray(projectIds) || !projectIds.every((id) => requiredString(id)))) return reply.code(400).send({ error: "projectIds must be a list of project ids" });
        if (reviewId === undefined && projectIds === undefined) return reply.code(400).send({ error: "reviewId or projectIds is required" });
        const result = changeReviewFeedback({ store, access, pageLock, terminalSessions }, req.viewer, req.params.sessionId, { reviewId, projectIds, takeOver: takeOver === true });
        return "error" in result ? reply.code(result.status).send({ error: result.error }) : result;
      });

      api.post<{ Params: { sessionId: string } }>("/terminal-sessions/:sessionId/bye", async (req, reply) => {
        terminalSessions.bye(req.params.sessionId);
        return reply.code(204).send();
      });

      // `browser_sign_in`: a 60-second single-use link that signs a headless test browser in as the token's own account.
      api.post<{ Body: { path?: unknown } | undefined }>("/sign-in-link", async (req, reply) => {
        const path = req.body?.path;
        if (path !== undefined && (typeof path !== "string" || !path.startsWith("#/"))) return reply.code(400).send({ error: "path is an in-app hash path such as #/pages/<id>" });
        const base = (publicUrl ?? `${req.protocol}://${req.headers.host}`).replace(/\/$/, "");
        if (access.mode === "none") return { url: `${base}/${path ?? ""}` };
        if (access.mode === "proxy") return reply.code(409).send({ error: "This instance signs people in through its SSO: the test browser needs the SSO session, not a Redline link." });
        const agentToken = req.headers.authorization?.slice("Bearer ".length) ?? "";
        const account = store.accounts.agentActorOf(agentToken)?.account;
        if (!account) return reply.code(409).send({ error: "This agent token stands for no account yet." });
        const now = Date.now();
        for (const [id, times] of signInLinkTimes) if (times.every((time) => now - time >= 60_000)) signInLinkTimes.delete(id);
        const recent = (signInLinkTimes.get(account.id) ?? []).filter((time) => now - time < 60_000);
        if (recent.length >= 10) return reply.code(429).send({ error: "Too many sign-in links asked: wait a minute." });
        signInLinkTimes.set(account.id, [...recent, now]);
        const token = store.accounts.issueAgentSignInLink(account.id, agentToken);
        store.accounts.log(`Agent sign-in link issued for ${account.email}.`);
        return { url: `${base}/#/connexion-agent/${token}${path === undefined ? "" : `?to=${encodeURIComponent(path)}`}` };
      });

      // `redline setup` and the update check read the instance from here: `/api/config` is behind the SSO in production.
      api.get("/instance", async (): Promise<RedlineInstanceResponse> => ({ ...config, hostProtocol: HOST_PROTOCOL_VERSION }));

      // `redline agent` picks or creates the projects a folder serves, before they have anything else to call.
      // `?all=1` (folder links) includes archived projects, so that a folder linked to one is not linked elsewhere.
      api.get<{ Querystring: { all?: string } }>("/projects", async (req) => store.listProjects(req.query.all ? "all" : "active").filter((project) => access.may(req.viewer, "write", { projectId: project.id })));

      api.post<{ Body: { title?: unknown; designSystem?: unknown } }>("/projects", async (req, reply) => {
        const { title } = req.body ?? {};
        const designSystem = req.body?.designSystem || null;
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        if (designSystem !== null && (typeof designSystem !== "string" || !store.getDesignSystem(designSystem))) {
          return reply.code(400).send({ error: "designSystem must be the id of an existing design system" });
        }
        if (designSystem !== null && store.isArchived(designSystem)) return reply.code(400).send({ error: "This design system is archived: choose another one." });
        return reply.code(201).send(store.createProject((title as string).trim(), undefined, undefined, designSystem, req.viewer.kind === "agent" && req.viewer.person ? { createdBy: req.viewer.person } : {}));
      });

      // Terminal mode sets up brands: list and create design systems, and point a project at one (or at none).
      api.get("/design-systems", async (): Promise<AgentDesignSystem[]> =>
        store.listChoosableDesignSystems().map((designSystem) => ({
          ...designSystem,
          pages: store.listPages(designSystem.id).map((page) => ({ id: page.id, title: page.title })),
          usedBy: store.projectsUsingDesignSystem(designSystem.id),
        })),
      );

      api.post<{ Body: { title?: unknown } }>("/design-systems", async (req, reply) => {
        const title = req.body?.title;
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        return reply.code(201).send(store.createDesignSystem((title as string).trim(), starterDesignSystemFiles()));
      });

      api.put<{ Params: { projectId: string }; Body: { designSystem?: unknown } }>("/projects/:projectId/design-system", async (req, reply) => {
        const designSystem = req.body?.designSystem ?? null;
        if (store.getDesignSystem(req.params.projectId) || !store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
        const invalid = designSystemChangeError(store, designSystem);
        if (invalid) return reply.code(400).send({ error: invalid });
        switchDesignSystem(store, req.params.projectId, designSystem as string | null, "terminal");
        return store.getProject(req.params.projectId);
      });

      // Terminal mode's `rename_project` and `archive_project`, for a project or a design system: an archived one is refused by the archived guard.
      api.post<{ Params: { projectId: string }; Body: { title?: unknown } }>("/projects/:projectId/rename", async (req, reply) => {
        const id = req.params.projectId;
        if (!archivableExists(store, id)) return reply.code(404).send({ error: "project not found" });
        const title = req.body?.title;
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        store.renameProject(id, (title as string).trim());
        // The session links the user to the project's page, or the design system's.
        return { ...projectOrDesignSystem(store, id), isDesignSystem: store.getDesignSystem(id) !== undefined };
      });

      api.post<{ Params: { projectId: string } }>("/projects/:projectId/archive", async (req, reply) => {
        if (!archivableExists(store, req.params.projectId)) return reply.code(404).send({ error: "project not found" });
        const result = archiveProject(store, pageLock, req.params.projectId);
        if (!("refusal" in result)) return result.archived;
        const { refusal } = result;
        if (refusal.reason !== "followed") return reply.code(409).send(refusal);
        // A session only reads `error`: it names the projects to switch first, and the archived ones to unarchive before.
        const followers = refusal.projects.map((p) => (p.archived ? `${p.title} (archived: unarchive it in Redline first)` : p.title)).join(", ");
        return reply.code(409).send({ ...refusal, error: `Projects still follow this design system (${followers}): change their design system first.` });
      });

      // Terminal mode finds and creates pages without having one checked out. A design system's own project, and an archived project, are not among them.
      const projectFor = (projectId: string) => (store.getDesignSystem(projectId) || store.isArchived(projectId) ? undefined : store.getProject(projectId));

      api.get<{ Params: { projectId: string } }>("/projects/:projectId/pages", async (req, reply) => {
        if (!projectFor(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
        return store.listPages(req.params.projectId, "active");
      });

      api.post<{ Params: { projectId: string }; Body: { title?: unknown } }>("/projects/:projectId/pages", async (req, reply) => {
        const project = projectFor(req.params.projectId);
        if (!project) return reply.code(404).send({ error: "project not found" });
        const title = req.body?.title;
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        const name = (title as string).trim();
        return reply.code(201).send(store.createPage(project.id, name, starterPageFiles(project.designSystem), "claude"));
      });

      api.get<{ Params: { pageId: string } }>("/pages/:pageId/files", async (req, reply): Promise<AgentCheckout> => {
        const checkout = store.readPageFiles(req.params.pageId);
        if (!checkout) return reply.code(404).send({ error: "page not found" });
        return { ...checkout, project: projectContext(store, req.params.pageId, (projectId) => realLevelOf(req, projectId) !== undefined) };
      });

      api.post<{ Params: { pageId: string }; Body: CreateVersionRequest }>("/pages/:pageId/versions", async (req, reply) => {
        const checkedOutPage = store.getPage(req.params.pageId);
        if (!checkedOutPage) return reply.code(404).send({ error: "page not found" });
        // Checked first: a refusal about a design system element would be wrong when the setting it was made under changed.
        if (req.body.followsDraft !== undefined && req.body.followsDraft !== store.projectFollowsDraft(checkedOutPage.projectId)) {
          return reply.code(409).send({ error: `The project's design system setting changed since this page was checked out: it now follows ${store.projectFollowsDraft(checkedOutPage.projectId) ? "the design system draft" : "the latest diffusion"}. Check the page out again.` });
        }
        const invalid = versionRequestError(req.body, store.isDesignSystemPage(req.params.pageId), true) ?? crossPageReferencesError(store, req.params.pageId, req.body.files) ?? versionComponentsError(store, req.params.pageId, req.body.files);
        if (invalid) return reply.code(400).send({ error: invalid });
        const invalidChanges = changesError(store, req.params.pageId, req.body.changes);
        if (invalidChanges) return reply.code(400).send({ error: invalidChanges });
        const { files, message, origin, baseVersionId, workId, designMd, projectStyle, changes } = req.body;
        // A session works inside its own project: its work never publishes to the pages of another one (a shared design system's, say).
        const workPage = typeof workId === "string" ? pageLock.itemOf(workId)?.pageId : undefined;
        if (workPage !== undefined && store.getPage(workPage)?.projectId !== store.getPage(req.params.pageId)!.projectId) {
          return reply.code(403).send({ error: "This work belongs to a page of another project: it cannot publish here." });
        }
        if (!requiredString(baseVersionId)) return reply.code(400).send({ error: "baseVersionId is required" });
        if (req.body.terminalSessionId !== undefined && !isTerminalSessionId(req.body.terminalSessionId)) return reply.code(400).send({ error: "terminalSessionId must be a UUID" });
        if (req.body.terminalSessionId !== undefined && !terminalSessions.claim(req.body.terminalSessionId, req.viewer.kind === "agent" ? req.viewer.person?.id : undefined)) {
          return reply.code(403).send({ error: "this terminal session belongs to another account" });
        }
        const invalidTitle = manifestTitleError(store, req.params.pageId, files, baseVersionId);
        if (invalidTitle) return reply.code(400).send({ error: invalidTitle });
        if (designMd !== undefined && (typeof designMd?.content !== "string" || typeof designMd.base !== "string")) {
          return reply.code(400).send({ error: "designMd needs content and base" });
        }
        if (projectStyle !== undefined && (typeof projectStyle?.content !== "string" || typeof projectStyle.base !== "string")) {
          return reply.code(400).send({ error: "projectStyle needs content and base" });
        }
        const record = () => {
          const result = mergeOntoCurrent(store, req.params.pageId, files, baseVersionId);
          if ("error" in result) return reply.code(result.conflict ? 409 : 400).send({ error: result.error });
          const invalidMerged = versionRequestError({ ...req.body, files: result.files }, store.isDesignSystemPage(req.params.pageId)) ?? versionComponentsError(store, req.params.pageId, result.files);
          if (invalidMerged) return reply.code(409).send({ error: invalidMerged });
          const projectId = store.getPage(req.params.pageId)!.projectId;
          const storedDesignMd = store.readProjectText(projectId, DESIGN_MD_PATH);
          const designMdChanged = designMd !== undefined && designMd.content !== storedDesignMd;
          if (designMdChanged && storedDesignMd !== designMd.base) {
            return reply.code(409).send({ error: "DESIGN.md changed since it was checked out. Check the page out again and redo the DESIGN.md change." });
          }
          const storedStyle = store.readProjectText(projectId, PROJECT_STYLE_PATH);
          const styleChanged = projectStyle !== undefined && projectStyle.content !== storedStyle;
          if (styleChanged && storedStyle !== projectStyle.base) {
            return reply.code(409).send({ error: "The project style (tokens.css) changed since it was checked out. Check the page out again and redo the tokens.css change." });
          }
          // On a design system's own project this file is the design system's tokens: the core tokens must stay.
          const invalidStyle = styleChanged && store.isDesignSystemProject(projectId) ? tokensError(projectStyle.content) : null;
          if (invalidStyle) return reply.code(400).send({ error: invalidStyle });
          const invalidRemoval = removalsError(store, req.params.pageId, result.files, styleChanged && store.isDesignSystemProject(projectId) ? projectStyle.content : result.files[DESIGN_SYSTEM_TOKENS_PATH], req.body.confirmRemovals === true) ?? instanceChangesError(store, req.params.pageId, result.files, req.body.confirmRemovals === true);
          if (invalidRemoval) return reply.code(400).send({ error: invalidRemoval });
          const from = workOrigin(store, pageLock, workId, req.params.pageId);
          // A terminal publish stays unsigned (no person) but names the folder of its session, so a review can say who modified an artboard.
          const terminalFolder = origin === "terminal" && req.body.terminalSessionId !== undefined ? terminalSessions.folderOf(req.body.terminalSessionId) : undefined;
          const ref: OriginRef | undefined = from ? { originId: from.originId, originLabel: from.originLabel, person: from.person } : terminalFolder ? { originLabel: folderName(terminalFolder), terminalSessionId: req.body.terminalSessionId } : undefined;
          const author = (): DesignMdAuthor => (from ? { origin: from.kind, ...ref } : { origin: origin === "terminal" ? "terminal" : "user" });
          const reportRemovals = watchDraftRemovals(store, pageLock, req.params.pageId);
          const version = store.addVersion(req.params.pageId, result.files, message, origin, ref);
          // The folder of a conversation that publishes a page knows it for its reminder line, as after a checkout.
          const label = origin === "terminal" && req.body.terminalSessionId !== undefined ? terminalSessions.labelOf(req.body.terminalSessionId) : undefined;
          if (label) store.rememberTerminalPage(label.accountId, label.folder, req.params.pageId);
          if (changes?.length) askToUndoRefused(store, pageLock, store.recordChanges(projectId, version.id, changes));
          settleUndoneChanges(store, req.params.pageId);
          if (designMdChanged) store.saveDesignMd(projectId, DESIGN_MD_PATH, Buffer.from(designMd.content, "utf8"), author());
          if (styleChanged) store.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(projectStyle.content, "utf8"), author());
          reportRemovals();
          const { gaps } = agentGaps(store, req.params.pageId, result.files);
          return reply.code(201).send({ ...version, ...(result.merged ? { merged: true } : {}), gaps });
        };
        if (origin !== "terminal") return record();
        // Terminal mode takes its turn on the page like a thread: wait while a session runs on it.
        const release = await pageLock.acquire(req.params.pageId);
        try {
          // The archive guard ran before the wait: the page (or its project) may have been archived, or deleted, meanwhile.
          const page = store.getPage(req.params.pageId);
          if (!page) return reply.code(404).send({ error: "page not found" });
          if (store.isArchived(page.projectId)) return reply.code(409).send({ error: archivedError(store, page.projectId) });
          if (page.archivedAt) return reply.code(409).send({ error: ARCHIVED_PAGE_ERROR });
          return record();
        } finally {
          release();
        }
      });

      // A session checks its working copy against the design system before its run is published.
      api.post<{ Params: { pageId: string }; Body: AgentGapsRequest }>("/pages/:pageId/gaps", async (req, reply) => {
        if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
        const files = req.body?.files;
        if (typeof files !== "object" || files === null || Object.values(files).some((content) => typeof content !== "string")) {
          return reply.code(400).send({ error: "files must map paths to text" });
        }
        return agentGaps(store, req.params.pageId, files);
      });

      // Raw bytes: an asset a session added or changed under `assets/` of its working copy, stored in the page's project.
      await api.register(async (scope) => {
        scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
        scope.put<{ Params: { pageId: string; "*": string }; Body: Buffer }>("/pages/:pageId/assets/*", { bodyLimit: MAX_ASSET_BYTES }, async (req, reply) => {
          const page = store.getPage(req.params.pageId);
          if (!page) return reply.code(404).send({ error: "page not found" });
          const asset = putProjectAsset(store, page.projectId, req.params["*"], req.body);
          return reply.code("error" in asset ? 400 : 201).send(asset);
        });
      });

      // "traite les commentaires" typed in a page's web chat: the running conversation message hands the page's threads to take to the agent, signed by its writer.
      api.post<{ Params: { pageId: string }; Body: Partial<HandOverCommentsRequest> }>("/pages/:pageId/hand-over-comments", async (req, reply) => {
        const workId = req.body?.workId;
        const item = typeof workId === "string" ? pageLock.itemOf(workId) : undefined;
        if (!item?.conversationId || item.pageId !== req.params.pageId) {
          return reply.code(403).send({ error: "Only the session answering a message of this page's conversation can hand its comments over." });
        }
        // Commentaire never hands over: the writer may have been lowered since the message was sent.
        const writer = pageLock.requesterOf(item.id);
        const account = writer ? store.accounts.activeAccounts().find((a) => a.id === writer.id) : undefined;
        if (writer && store.isDeactivated(writer.id)) return reply.code(403).send({ error: `${nameOf(writer)}'s account is deactivated: the threads are left alone.` });
        if (writer && accountLevelIn(store, { id: writer.id, role: account?.role }, store.getPage(item.pageId)!.projectId) !== "write") {
          return reply.code(403).send({ error: `${nameOf(writer)} no longer has Écriture on this project: the threads are left alone.` });
        }
        return reply.send(handOverPage(store, pageLock, item.pageId, writer));
      });

      api.post<{ Params: { pageId: string }; Body: Partial<CreateSiblingRequest> }>("/pages/:pageId/siblings", async (req, reply) => {
        const page = store.getPage(req.params.pageId);
        if (!page) return reply.code(404).send({ error: "page not found" });
        const { title, workId } = req.body ?? {};
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        const name = (title as string).trim();
        const designSystem = store.getProject(page.projectId)?.designSystem;
        const from = workOrigin(store, pageLock, workId, page.id);
        const created = store.createPage(page.projectId, name, starterPageFiles(designSystem), "claude", from?.person);
        if (from) store.recordCreatedPage(workId!, created.id);
        return reply.code(201).send(created);
      });

      api.put<{ Params: { pageId: string }; Body: Partial<RenamePageRequest> }>("/pages/:pageId/title", async (req, reply) => {
        const page = store.getPage(req.params.pageId);
        if (!page) return reply.code(404).send({ error: "page not found" });
        const { title, workId } = req.body ?? {};
        const invalid = titleError(title);
        if (invalid) return reply.code(400).send({ error: invalid });
        // A session renames only the pages of its own project; a work item it no longer runs renames nothing.
        const workPage = typeof workId === "string" ? pageLock.itemOf(workId)?.pageId : undefined;
        if (workId !== undefined && store.getPage(workPage ?? "")?.projectId !== page.projectId) {
          return reply.code(403).send({ error: "This session cannot rename that page: it belongs to another project, or the run is over." });
        }
        store.renamePage(page.id, (title as string).trim());
        return store.getPage(page.id);
      });

      // `archive_page`: a session archives a page of its own project, but not the one it works on; terminal mode, any active page.
      api.post<{ Params: { pageId: string }; Body: { workId?: unknown } }>("/pages/:pageId/archive", async (req, reply) => {
        const page = store.getPage(req.params.pageId);
        if (!page) return reply.code(404).send({ error: "page not found" });
        const workId = req.body?.workId;
        const workPage = typeof workId === "string" ? pageLock.itemOf(workId)?.pageId : undefined;
        if (workId !== undefined && store.getPage(workPage ?? "")?.projectId !== page.projectId) {
          return reply.code(403).send({ error: "This session cannot archive that page: it belongs to another project, or the run is over." });
        }
        const { status, body } = archivePage(store, pageLock, page);
        return reply.code(status).send(body);
      });

      // A project's session asks its design system for something a component lacks (agent sessions and terminal mode alike).
      api.post<{ Params: { pageId: string }; Body: Partial<SendRequestRequest> }>("/pages/:pageId/requests", async (req, reply) => {
        if (workOutsideProject(req.body?.workId, store.getPage(req.params.pageId)?.projectId)) {
          return reply.code(403).send({ error: "This session cannot send a request for that page: it belongs to another project, or the run is over." });
        }
        const outcome = sendRequest(store, pageLock, req.params.pageId, req.body);
        return reply.code(outcome.status).send(outcome.body);
      });

      // The design system's session attaches a request to an existing one.
      api.post<{ Params: { threadId: string }; Body: Partial<MergeRequestRequest> }>("/requests/:threadId/merge", async (req, reply) => {
        if (workOutsideProject(req.body?.workId, store.getPage(store.getThread(req.params.threadId)?.pageId ?? "")?.projectId)) {
          return reply.code(403).send({ error: "This session cannot merge that request: it belongs to another project, or the run is over." });
        }
        const outcome = mergeRequests(store, req.params.threadId, req.body?.into);
        return reply.code(outcome.status).send(outcome.body);
      });

      api.post<{ Params: { pageId: string }; Body: Partial<MoveArtboardRequest> }>("/pages/:pageId/move-artboard", async (req, reply) => {
        const { workId } = req.body ?? {};
        const from = workOrigin(store, pageLock, workId, req.params.pageId);
        const outcome = moveArtboard(store, pageLock, req.params.pageId, req.body, {
          origin: from?.kind ?? "terminal",
          ref: from && { originId: from.originId, originLabel: from.originLabel, person: from.person },
          exceptWorkId: from ? workId : undefined,
        });
        return reply.code(outcome.status).send(outcome.body);
      });

      api.post<{ Params: { threadId: string }; Body: AgentReplyRequest }>("/threads/:threadId/replies", async (req, reply) => {
        const body = req.body?.body;
        if (!requiredString(body)) return reply.code(400).send({ error: "body is required" });
        const resolve = req.body.resolve;
        if (resolve !== undefined && typeof resolve !== "boolean") return reply.code(400).send({ error: "resolve must be a boolean" });
        const thread = store.getThread(req.params.threadId);
        if (!thread) return reply.code(404).send({ error: "This thread no longer exists: it was deleted with its page." });
        // A draft is its author's: nobody answers it, a run never sees it.
        if (thread.status === "held") return reply.code(409).send({ error: "This thread is a draft that was not sent yet: it cannot be answered." });
        // A conversation answers any thread of a project its account writes in: the answer is always added, never lost.
        const { terminalSessionId } = req.body;
        if (terminalSessionId !== undefined) {
          const label = terminalSessions.labelOf(terminalSessionId);
          if (!label) return reply.code(403).send({ error: notConnected });
          if (label.accountId !== (req.viewer.kind === "agent" ? (req.viewer.person?.id ?? "") : "")) return reply.code(403).send({ error: "this terminal session belongs to another account" });
          const refusal = refusalOf(req, label.accountId, store.projectIdOfPage(thread.pageId)!);
          if (refusal) return reply.code(403).send({ error: refusal });
          const answered = replyFromConversation(store, pageLock, thread, label, body, resolve);
          if ("error" in answered) return reply.code(409).send({ error: answered.error });
          const response: AgentReplyResponse = { ...answered.reply, ...(answered.note ? { note: answered.note } : {}) };
          return reply.code(201).send(response);
        }
        // The pages the run created appear under its first answer.
        const workId = req.body.workId;
        const createdPageIds = workOrigin(store, pageLock, workId, thread.pageId) ? store.takeCreatedPages(workId!) : [];
        const posted = store.addReply(thread.id, body, "claude", createdPageIds);
        if (resolve) store.resolveThread(thread.id);
        return reply.code(201).send(posted);
      });
    },
    { prefix: AGENT_API_PREFIX },
  );
}
