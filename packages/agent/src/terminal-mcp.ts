import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MANIFEST_PATH, defaultManifest, groupTitlesOf, parseManifest, readingOrder, renderingSlots, responsiveFrameLayout } from "@redline/shared";
import { z } from "zod";
import { uploadChangedAssets } from "./assets.js";
import { readLinkedProjectId } from "./link.js";
import type { ServerApi } from "./server-api.js";
import { CREATE_PAGE_TOOL, createRedlineMcpServer } from "./session-mcp.js";
import { readDesignMd, readWorkingCopy, sameFiles, workingCopyDir, writeWorkingCopy } from "./working-copy.js";

export const CHECKOUT_PAGE_TOOL = "checkout_page";
export const PUBLISH_PAGE_TOOL = "publish_page";
export const LIST_PROJECTS_TOOL = "list_projects";
export const LIST_PAGES_TOOL = "list_pages";
export const CREATE_PROJECT_TOOL = "create_project";

const text = (message: string, isError = false) => ({ ...(isError ? { isError } : {}), content: [{ type: "text" as const, text: message }] });

/** The page address, then one numbered line per artboard in canvas reading order: title, canvas address, play address. */
function pageAddresses(api: ServerApi, pageId: string, files: Record<string, string>): string {
  const manifest = files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(files[MANIFEST_PATH]);
  const boxes = manifest.artboards.map((artboard) => ({
    file: artboard.file,
    title: artboard.title,
    ...(artboard.responsive ? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive)).frame : artboard),
  }));
  const lines = readingOrder(boxes, groupTitlesOf(manifest)).map(
    ({ number, file, title }) => `${number}. ${title ?? file} · canvas ${api.artboardUrl(pageId, file)} · play ${api.playUrl(pageId, file)}`,
  );
  return [`Page: ${api.pageUrl(pageId)}`, ...(lines.length ? ["Artboards, in reading order:", ...lines] : [])].join("\n");
}

interface Checkout {
  pageId: string;
  dir: string;
  /** The files as published or downloaded last: what "changed" is measured against. */
  files: Record<string, string>;
  /** DESIGN.md as published or downloaded last. */
  designMd: string;
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
export function createTerminalMcpServer({ api, folder }: { api: ServerApi; folder: string }): McpServer {
  let current: Checkout | undefined;
  const checkedOut = (): Checkout => {
    if (!current) throw new Error("No page checked out. Call checkout_page first.");
    return current;
  };
  const server = createRedlineMcpServer({
    api,
    allowedThreadIds: [],
    get pageId() {
      return checkedOut().pageId;
    },
    get workingCopyDir() {
      return checkedOut().dir;
    },
    ownCreatePage: true,
  });
  const tool = <T,>(run: (args: T) => Promise<string>) => async (args: T) => {
    try {
      return text(await run(args));
    } catch (error) {
      return text((error as Error).message, true);
    }
  };
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
      description: "Create a Redline project. It does not link the current folder to it (that is `redline init`).",
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
    CREATE_PAGE_TOOL,
    {
      description:
        "Create a new, empty page (a manifest, no artboard). Without projectId it goes in the project of the checked-out page, else of the folder linked by `redline init`.",
      inputSchema: { title: z.string(), projectId: z.string().optional().describe("Id of the project (see list_projects)") },
    },
    tool(async ({ title, projectId }: { title: string; projectId?: string }) => {
      const target = projectId?.trim() || (current ? undefined : readLinkedProjectId(folder));
      if (!target && !current) {
        throw new Error("No project to create the page in: pass projectId (see list_projects), or check out a page of the project first.");
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
      current = { pageId, dir, files: checkout.files, designMd: checkout.project.designMd, assets: checkout.project.assets, versionId: checkout.versionId };
      return `Page checked out into .redline/${pageId}/. Edit its files, then call publish_page.\n${pageAddresses(api, pageId, checkout.files)}`;
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
      const { pageId, dir, files: base, designMd: baseDesignMd, versionId } = checkout;
      const files = readWorkingCopy(dir);
      // DESIGN.md is published with the page, as in a session run (a deleted file counts as unchanged).
      const designMd = readDesignMd(dir) ?? baseDesignMd;
      // Assets belong to the project: new or changed ones go up first, so the version that uses them shows them.
      const { uploaded, assets } = await uploadChangedAssets(api, pageId, dir, checkout.assets);
      checkout.assets = assets;
      const uploadedNote = uploaded.length ? `Uploaded ${uploaded.map((name) => `assets/${name}`).join(", ")}. ` : "";
      if (sameFiles(files, base) && designMd === baseDesignMd) {
        return uploaded.length ? `${uploadedNote}No page file changed; no version published.` : "Nothing changed; no version published.";
      }
      const version = await api.publish(pageId, files, message, "terminal", versionId, {
        ...(designMd !== baseDesignMd ? { designMd: { content: designMd, base: baseDesignMd } } : {}),
      });
      if (!version.merged) {
        current = { pageId, dir, files, designMd, assets, versionId: version.id };
        return `${uploadedNote}Published version ${version.id}: ${api.pageUrl(pageId)}.`;
      }
      // The page moved on since the checkout: the new version also holds those changes, so download it again.
      const fresh = await api.checkout(pageId);
      writeWorkingCopy(folder, pageId, fresh);
      current = { pageId, dir, files: fresh.files, designMd: fresh.project.designMd, assets: fresh.project.assets, versionId: fresh.versionId };
      return `${uploadedNote}Published version ${version.id}: ${api.pageUrl(pageId)}, merged with changes made to the page since the checkout. The working copy was refreshed.`;
    }),
  );
  return server;
}

/** Serves the terminal MCP server on stdin/stdout until the client goes away. */
export async function serveTerminalMcp(options: { api: ServerApi; folder: string }): Promise<void> {
  await createTerminalMcpServer(options).connect(new StdioServerTransport());
}
