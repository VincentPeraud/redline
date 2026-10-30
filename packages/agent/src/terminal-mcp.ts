import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { uploadChangedAssets } from "./assets.js";
import { readLinkedProjectIds } from "./link.js";
import { pageAddresses } from "./page-addresses.js";
import { buildHash } from "./build-hash.js";
import type { ServerApi } from "./server-api.js";
import { CREATE_PAGE_TOOL, createRedlineMcpServer, type ToolResult } from "./session-mcp.js";
import { designSystemHint, designSystemNote, gapsNote, layoutNote } from "./design-system-note.js";
import { readDesignMd, readDesignSystemEdits, readProjectStyle, readWorkingCopy, sameFiles, workingCopyDir, writeWorkingCopy } from "./working-copy.js";

export const CHECKOUT_PAGE_TOOL = "checkout_page";
export const PUBLISH_PAGE_TOOL = "publish_page";
export const LIST_PROJECTS_TOOL = "list_projects";
export const LIST_PAGES_TOOL = "list_pages";
export const CREATE_PROJECT_TOOL = "create_project";
export const LIST_DESIGN_SYSTEMS_TOOL = "list_design_systems";
export const CREATE_DESIGN_SYSTEM_TOOL = "create_design_system";
export const SET_PROJECT_DESIGN_SYSTEM_TOOL = "set_project_design_system";
export const RELEASE_PAGE_TOOL = "release_page";
export const PENDING_COMMENTS_TOOL = "pending_comments";

/** The last line of every answer: the comments waiting for this session, per page; nothing when there are none (or the server cannot be asked). */
async function waitingLine(api: ServerApi, sessionId: string): Promise<string | undefined> {
  const pages = await api.terminalWaiting(sessionId).catch(() => []);
  if (pages.length === 0) return undefined;
  const parts = pages.map((page, i) => (i === 0 ? `${page.count} commentaire${page.count > 1 ? "s" : ""} en attente sur ${page.title}` : `${page.count} sur ${page.title}`));
  return `Redline: ${parts.join(", ")} : appelle pending_comments si la personne le demande.`;
}

const text = (message: string, isError = false) => ({ ...(isError ? { isError } : {}), content: [{ type: "text" as const, text: message }] });

interface Checkout {
  pageId: string;
  dir: string;
  /** The files as published or downloaded last: what "changed" is measured against. */
  files: Record<string, string>;
  /** DESIGN.md as published or downloaded last. */
  designMd: string;
  /** Project style `tokens.css` as published or downloaded last (undefined for a design system's own project). */
  projectStyle: string | undefined;
  /** Files of `.design-system/` as downloaded (project pages only): what an edit of that read-only folder is measured against. */
  designSystemFiles: Record<string, string> | undefined;
  /** Files of `.project-components/` as downloaded (project pages only), measured the same way. */
  projectComponents: Record<string, string> | undefined;
  /** Project assets as uploaded or downloaded last (name -> base64). */
  assets: Record<string, string>;
  versionId: string;
}

/**
 * Terminal mode: the user's own Claude Code talks to this server over stdio (`redline mcp`).
 * `checkout_page` downloads a page into `.redline/<page>/` of `folder`, `publish_page` uploads the
 * changes as one version with origin "terminal" (the server makes it wait for the page lock).
 * No thread or conversation is involved.
 */
/** `runningBuild` is the build this process loaded; `installedBuild` reads the one installed now (an update replaces it on disk). */
export function createTerminalMcpServer({ api, folder, sessionId = randomUUID(), runningBuild = buildHash(), installedBuild = buildHash }: { api: ServerApi; folder: string; sessionId?: string; runningBuild?: string; installedBuild?: () => string }): McpServer {
  let current: Checkout | undefined;
  let removalsConfirmed = false;
  const checkedOut = (): Checkout => {
    if (!current) throw new Error("No page checked out. Call checkout_page first.");
    return current;
  };
  let noticeSent = false;
  const server = createRedlineMcpServer({
    api,
    // One line, in the first answer only, once the server has said this CLI is out of date.
    decorateResult: async (result) => {
      const waiting = await waitingLine(api, sessionId);
      const withWaiting: ToolResult = waiting ? { ...result, content: [...result.content, { type: "text", text: waiting }] } : result;
      if (noticeSent || !api.outdated) return withWaiting;
      noticeSent = true;
      const [first, ...rest] = withWaiting.content;
      const notice = `Redline: this CLI is not up to date. Tell the user to update it with \`${api.updateCommand()}\`, then to type /mcp in Claude Code and reconnect redline.`;
      return { ...withWaiting, content: [{ type: "text", text: first ? `${notice}\n${first.text}` : notice }, ...rest] };
    },
    // The CLI was reinstalled under this running MCP (the Agents screen's update, or npm by hand): its code is the previous one
    // until Claude Code reconnects it, so no tool runs. "dev" (sources, or a file being replaced) never pauses.
    refuseCall: () => {
      const installed = installedBuild();
      if (runningBuild === "dev" || installed === "dev" || installed === runningBuild) return undefined;
      return {
        isError: true,
        content: [{ type: "text", text: "Redline: the Redline CLI was updated on this machine, but this MCP still runs the previous version, so its tools are paused. Tell the user to type /mcp in Claude Code and reconnect redline, then call the tool again." }],
      };
    },
    // The server answers only for the threads this session picked with pending_comments.
    postReply: (threadId, replyText) => api.replyInThread(threadId, replyText, undefined, sessionId),
    get pageId() {
      return checkedOut().pageId;
    },
    get workingCopyDir() {
      return checkedOut().dir;
    },
    ownCreatePage: true,
    onRemovalsConfirmed: () => void (removalsConfirmed = true),
    // The page changed on the server: take its new state as the base of the next publish.
    afterArtboardMoved: async () => {
      const { pageId } = checkedOut();
      const fresh = await api.checkout(pageId);
      const dir = writeWorkingCopy(folder, pageId, fresh);
      current = { pageId, dir, files: fresh.files, designMd: fresh.project.designMd, projectStyle: fresh.project.projectStyle, designSystemFiles: fresh.project.designSystem?.files, projectComponents: fresh.project.projectComponents, assets: fresh.project.assets, versionId: fresh.versionId };
    },
  });
  const tool = <T,>(run: (args: T) => Promise<string>) => async (args: T) => {
    try {
      return text(await run(args));
    } catch (error) {
      return text((error as Error).message, true);
    }
  };
  server.registerTool(
    PENDING_COMMENTS_TOOL,
    {
      description:
        "Take the Redline comments waiting for this session (on the pages it published), grouped by page, with each page's and artboard's addresses. Call it only when the user asks you to handle their comments. Taking them marks the threads as being handled by you: answer each one with reply_in_thread.",
    },
    tool(async () => {
      const pages = await api.terminalPick(sessionId);
      if (pages.length === 0) return "No comment is waiting for this session.";
      const sections = await Promise.all(
        pages.map(async ({ pageId, title, messages }) => {
          const { files } = await api.checkout(pageId);
          return [`## ${title}`, pageAddresses(api, pageId, files), "", messages.join("\n\n---\n\n")].join("\n");
        }),
      );
      const steps = "For each page: checkout_page, make the changes the comments ask for, then publish_page once. Then answer each thread once with reply_in_thread (threadId as given).";
      return `${steps}\n\n${sections.join("\n\n=====\n\n")}`;
    }),
  );
  server.registerTool(
    LIST_PROJECTS_TOOL,
    { description: "List the Redline projects, with their ids and links." },
    tool(async () => {
      const projects = await api.listProjects();
      if (projects.length === 0) return "No project yet. Create one with create_project.";
      return projects.map((p) => `- ${p.title} · id ${p.id} · ${api.projectUrl(p.id)}`).join("\n");
    }),
  );
  server.registerTool(
    LIST_PAGES_TOOL,
    {
      description: "List the pages of a Redline project, with their ids and links.",
      inputSchema: { projectId: z.string().describe("Id of the project (see list_projects)") },
    },
    tool(async ({ projectId }: { projectId: string }) => {
      const pages = await api.listPages(projectId);
      if (pages.length === 0) return "No page in this project yet. Create one with create_page.";
      return pages.map((p) => `- ${p.title} · id ${p.id} · ${api.pageUrl(p.id)}`).join("\n");
    }),
  );
  server.registerTool(
    CREATE_PROJECT_TOOL,
    {
      description: "Create a Redline project. It does not link the current folder to it (`redline agent` does, when asked to add a project).",
      inputSchema: {
        title: z.string(),
        designSystem: z.string().optional().describe("Id of an existing design system (refused when unknown); none uses the neutral default"),
      },
    },
    tool(async ({ title, designSystem }: { title: string; designSystem?: string }) => {
      const project = await api.createProject(title, designSystem);
      return `Project "${project.title}" created (id ${project.id}): ${api.projectUrl(project.id)}. Add its first page with create_page.`;
    }),
  );
  server.registerTool(
    LIST_DESIGN_SYSTEMS_TOOL,
    { description: "List the shared design systems, with their ids, their pages (check these out with checkout_page to edit the design system) and the projects using them." },
    tool(async () => {
      const list = await api.listDesignSystems();
      if (list.length === 0) return "No design system yet. Create one with create_design_system.";
      return list
        .map((ds) => {
          const pages = ds.pages.map((page) => `  - ${page.title} · page ${page.id} · ${api.pageUrl(page.id)}`).join("\n");
          const used = ds.usedBy.length > 0 ? `used by ${ds.usedBy.map((p) => p.title).join(", ")}` : "used by no project";
          return `- ${ds.title} · id ${ds.id} · ${used}\n${pages}`;
        })
        .join("\n");
    }),
  );
  server.registerTool(
    CREATE_DESIGN_SYSTEM_TOOL,
    {
      description:
        "Create a shared design system, starting with the core tokens and one page. Check that page out with checkout_page to fill tokens.css, DESIGN.md and components/, then publish_page. Projects only see it after the user diffuses it in Redline.",
      inputSchema: { title: z.string() },
    },
    tool(async ({ title }: { title: string }) => {
      const ds = await api.createDesignSystem(title);
      return `Design system "${ds.title}" created (id ${ds.id}), first page: page ${ds.pageId} · ${api.pageUrl(ds.pageId)}. Call checkout_page with that page id to fill it.`;
    }),
  );
  server.registerTool(
    SET_PROJECT_DESIGN_SYSTEM_TOOL,
    {
      description:
        "Point a project at a shared design system, or at none (designSystem null: its tokens.css becomes its whole style). Existing pages are switched with it. Leaving a shared design system for none copies that design system's current values into the project's tokens.css, the project's own overrides keeping their value.",
      inputSchema: {
        projectId: z.string().describe("Id of the project (see list_projects)"),
        designSystem: z.string().nullable().describe("Id of a design system (see list_design_systems), or null for none"),
      },
    },
    tool(async ({ projectId, designSystem }: { projectId: string; designSystem: string | null }) => {
      const project = await api.setProjectDesignSystem(projectId, designSystem);
      return designSystem === null
        ? `Project "${project.title}" now has no shared design system: its own tokens.css is its whole style.`
        : `Project "${project.title}" now uses the design system ${designSystem}.`;
    }),
  );
  server.registerTool(
    CREATE_PAGE_TOOL,
    {
      description:
        "Create a new, empty page (a manifest, no artboard). Without projectId it goes in the project of the checked-out page, else of the folder's linked project when it is linked to only one.",
      inputSchema: { title: z.string(), projectId: z.string().optional().describe("Id of the project (see list_projects)") },
    },
    tool(async ({ title, projectId }: { title: string; projectId?: string }) => {
      const linked = readLinkedProjectIds(folder);
      const target = projectId?.trim() || (current || linked.length !== 1 ? undefined : linked[0]);
      if (!target && !current) {
        const why = linked.length > 1 ? " (this folder is linked to several projects)" : "";
        throw new Error(`No project to create the page in${why}: pass projectId (see list_projects), or check out a page of the project first.`);
      }
      const page = target ? await api.createPage(target, title) : await api.createPageBeside(current!.pageId, title);
      return `Page "${page.title}" created (id ${page.id}), empty: ${api.pageUrl(page.id)}. Call checkout_page with this id to add its artboards.`;
    }),
  );
  server.registerTool(
    CHECKOUT_PAGE_TOOL,
    {
      description:
        "Download a Redline page into .redline/<pageId>/ of the current folder (replacing any earlier copy). Edit the files there, then call publish_page.",
      inputSchema: { pageId: z.string().describe("Id of the page (the last part of its URL in Redline)") },
    },
    tool(async ({ pageId }: { pageId: string }) => {
      workingCopyDir(folder, pageId);
      const checkout = await api.checkout(pageId);
      const dir = writeWorkingCopy(folder, pageId, checkout);
      current = {
        pageId,
        dir,
        files: checkout.files,
        designMd: checkout.project.designMd,
        projectStyle: checkout.project.projectStyle,
        designSystemFiles: checkout.project.designSystem?.files,
        projectComponents: checkout.project.projectComponents,
        assets: checkout.project.assets,
        versionId: checkout.versionId,
      };
      return `Page checked out into .redline/${pageId}/. Edit its files, then call publish_page.\n${pageAddresses(api, pageId, checkout.files)}\n${designSystemNote(checkout.project)}`;
    }),
  );
  server.registerTool(
    PUBLISH_PAGE_TOOL,
    {
      description: "Publish the changes made in the checked-out page as one new version. Waits if a Redline session is running on the page.",
      inputSchema: { message: z.string().describe("Short description of the version") },
    },
    tool(async ({ message }: { message: string }) => {
      const checkout = checkedOut();
      const { pageId, dir, files: base, designMd: baseDesignMd, projectStyle: baseStyle, designSystemFiles, projectComponents, versionId } = checkout;
      const pageFiles = readWorkingCopy(dir, baseStyle !== undefined);
      // Edits of the read-only `.design-system/` and `.project-components/` go up with the page files so that the server refuses them.
      const files = { ...pageFiles, ...readDesignSystemEdits(dir, designSystemFiles, projectComponents) };
      // DESIGN.md is published with the page, as in a session run (a deleted file counts as unchanged).
      const designMd = readDesignMd(dir) ?? baseDesignMd;
      const projectStyle = baseStyle === undefined ? undefined : (readProjectStyle(dir) ?? baseStyle);
      // Assets belong to the project: new or changed ones go up first, so the version that uses them shows them.
      const { uploaded, assets } = await uploadChangedAssets(api, pageId, dir, checkout.assets);
      checkout.assets = assets;
      const uploadedNote = uploaded.length ? `Uploaded ${uploaded.map((name) => `assets/${name}`).join(", ")}. ` : "";
      if (sameFiles(files, base) && designMd === baseDesignMd && projectStyle === baseStyle) {
        return uploaded.length ? `${uploadedNote}No page file changed; no version published.` : "Nothing changed; no version published.";
      }
      const hint = designSystemHint(pageFiles, designSystemFiles);
      const confirmRemovals = removalsConfirmed;
      removalsConfirmed = false;
      const version = await api.publish(pageId, files, message, "terminal", versionId, {
        terminalSessionId: sessionId,
        ...(confirmRemovals ? { confirmRemovals: true } : {}),
        ...(designMd !== baseDesignMd ? { designMd: { content: designMd, base: baseDesignMd } } : {}),
        ...(projectStyle !== baseStyle ? { projectStyle: { content: projectStyle!, base: baseStyle! } } : {}),
      });
      const hintAfter = [hint, gapsNote(version.gaps ?? []), layoutNote(pageFiles)].map((note) => (note ? `\n${note}` : "")).join("");
      if (!version.merged) {
        current = { pageId, dir, files, designMd, projectStyle, designSystemFiles, projectComponents, assets, versionId: version.id };
        return `${uploadedNote}Published version ${version.id}: ${api.pageUrl(pageId)}.${hintAfter}`;
      }
      // The page moved on since the checkout: the new version also holds those changes, so download it again.
      const fresh = await api.checkout(pageId);
      writeWorkingCopy(folder, pageId, fresh);
      current = {
        pageId,
        dir,
        files: fresh.files,
        designMd: fresh.project.designMd,
        projectStyle: fresh.project.projectStyle,
        designSystemFiles: fresh.project.designSystem?.files,
        projectComponents: fresh.project.projectComponents,
        assets: fresh.project.assets,
        versionId: fresh.versionId,
      };
      return `${uploadedNote}Published version ${version.id}: ${api.pageUrl(pageId)}, merged with changes made to the page since the checkout. The working copy was refreshed.${hintAfter}`;
    }),
  );
  server.registerTool(
    RELEASE_PAGE_TOOL,
    {
      description:
        "Stop holding a page: its waiting comments go to the Redline agent, and new comments go to the agent until a terminal session publishes the page again. Without pageId, releases every page this session holds. Use it when the user asks you to let go of a page.",
      inputSchema: { pageId: z.string().optional().describe("Id of the page to release; leave out to release all the pages this session holds") },
    },
    tool(async ({ pageId }: { pageId?: string }) => {
      const released = await api.terminalRelease(sessionId, pageId);
      if (released.length === 0) return "This session holds no page: nothing to release.";
      const lines = released.map((page) => `- ${page.title}: ${page.count === 0 ? "no waiting comment" : `${page.count} comment${page.count > 1 ? "s" : ""} handed over to the agent`}`);
      return `Released ${released.length > 1 ? "these pages" : "this page"}; the agent now takes its comments until a terminal session publishes ${released.length > 1 ? "them" : "it"} again:\n${lines.join("\n")}`;
    }),
  );
  return server;
}

export const PRESENCE_INTERVAL_MS = 20_000;

/**
 * Tells the server this terminal session is present now and then every `intervalMs`; `stop` says bye (best effort) and stops.
 * A heartbeat that fails is simply sent again at the next tick.
 */
export function startPresence({ api, sessionId, folder, machine = hostname(), intervalMs = PRESENCE_INTERVAL_MS }: { api: ServerApi; sessionId: string; folder: string; machine?: string; intervalMs?: number }): { firstBeat: Promise<void>; stop: () => Promise<void> } {
  const beat = () => api.terminalHeartbeat(sessionId, folder, machine).catch(() => undefined);
  const firstBeat = beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return {
    firstBeat,
    stop: async () => {
      clearInterval(timer);
      await api.terminalBye(sessionId).catch(() => undefined);
    },
  };
}

/** Serves the terminal MCP server on stdin/stdout until the client goes away. */
export async function serveTerminalMcp({ api, folder }: { api: ServerApi; folder: string }): Promise<void> {
  const sessionId = randomUUID();
  const server = createTerminalMcpServer({ api, folder, sessionId });
  const transport = new StdioServerTransport();
  const presence = startPresence({ api, sessionId, folder });
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.stdin.on("end", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.connect(transport);
  await closed;
  await presence.stop();
}
