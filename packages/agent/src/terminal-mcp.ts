import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { uploadChangedAssets } from "./assets.js";
import type { ServerApi } from "./server-api.js";
import { createRedlineMcpServer } from "./session-mcp.js";
import { readDesignMd, readWorkingCopy, sameFiles, workingCopyDir, writeWorkingCopy } from "./working-copy.js";

export const CHECKOUT_PAGE_TOOL = "checkout_page";
export const PUBLISH_PAGE_TOOL = "publish_page";

const text = (message: string, isError = false) => ({ ...(isError ? { isError } : {}), content: [{ type: "text" as const, text: message }] });

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
  });
  server.registerTool(
    CHECKOUT_PAGE_TOOL,
    {
      description:
        "Download a Redline page into .redline/<pageId>/ of the current folder (replacing any earlier copy). Edit the files there, then call publish_page.",
      inputSchema: { pageId: z.string().describe("Id of the page (the last part of its URL in Redline)") },
    },
    async ({ pageId }) => {
      try {
        workingCopyDir(folder, pageId);
        const checkout = await api.checkout(pageId);
        const dir = writeWorkingCopy(folder, pageId, checkout);
        current = { pageId, dir, files: checkout.files, designMd: checkout.project.designMd, assets: checkout.project.assets, versionId: checkout.versionId };
        return text(`Page checked out into .redline/${pageId}/. Edit its files, then call publish_page.`);
      } catch (error) {
        return text((error as Error).message, true);
      }
    },
  );
  server.registerTool(
    PUBLISH_PAGE_TOOL,
    {
      description: "Publish the changes made in the checked-out page as one new version. Waits if a Redline session is running on the page.",
      inputSchema: { message: z.string().describe("Short description of the version") },
    },
    async ({ message }) => {
      try {
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
          return text(uploaded.length ? `${uploadedNote}No page file changed; no version published.` : "Nothing changed; no version published.");
        }
        const version = await api.publish(pageId, files, message, "terminal", versionId, {
          ...(designMd !== baseDesignMd ? { designMd: { content: designMd, base: baseDesignMd } } : {}),
        });
        if (!version.merged) {
          current = { pageId, dir, files, designMd, assets, versionId: version.id };
          return text(`${uploadedNote}Published version ${version.id}.`);
        }
        // The page moved on since the checkout: the new version also holds those changes, so download it again.
        const fresh = await api.checkout(pageId);
        writeWorkingCopy(folder, pageId, fresh);
        current = { pageId, dir, files: fresh.files, designMd: fresh.project.designMd, assets: fresh.project.assets, versionId: fresh.versionId };
        return text(`${uploadedNote}Published version ${version.id}, merged with changes made to the page since the checkout. The working copy was refreshed.`);
      } catch (error) {
        return text((error as Error).message, true);
      }
    },
  );
  return server;
}

/** Serves the terminal MCP server on stdin/stdout until the client goes away. */
export async function serveTerminalMcp(options: { api: ServerApi; folder: string }): Promise<void> {
  await createTerminalMcpServer(options).connect(new StdioServerTransport());
}
