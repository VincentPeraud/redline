import type { FastifyInstance } from "fastify";
import {
  MANIFEST_PATH,
  PROJECT_STYLE_PATH,
  analyseGaps,
  componentClassesOf,
  componentNameOf,
  defaultManifest,
  pageGapsPath,
  parseManifest,
  parseTokens,
  type GapContext,
  type PageGaps,
} from "@redline/shared";
import { componentFilesOf } from "./components.js";
import { sharedDesignSystemIdOf } from "./project-files.js";
import type { Store } from "./store.js";

/** Tokens and components a page's artboards can use: the design system's current diffusion with the project's own style over it. */
function gapContext(store: Store, designSystemId: string, projectId: string): GapContext {
  const diffusion = store.currentDiffusion(designSystemId);
  const read = (file: Parameters<Store["readDiffusionFile"]>[2]) => (diffusion ? store.readDiffusionFile(designSystemId, diffusion.number, file) : undefined);

  const tokens = new Map(parseTokens(read("tokens.css") ?? "").map((t) => [t.name, t]));
  for (const token of parseTokens(store.readProjectText(projectId, PROJECT_STYLE_PATH))) tokens.set(token.name, token);

  const sharedFiles = diffusion ? store.diffusionComponentFiles(designSystemId, diffusion.number) : {};
  const components = new Map<string, string[]>();
  for (const [path, content] of [...Object.entries(sharedFiles), ...Object.entries(componentFilesOf(store, projectId))]) {
    components.set(componentNameOf(path)!, componentClassesOf(content));
  }
  return { tokens: [...tokens.values()], components: [...components].map(([name, classes]) => ({ name, classes })) };
}

/** The gaps of a page's artboards in `files`; none on a design system's own pages, which are the system. */
function gapsOfFiles(store: Store, pageId: string, files: Record<string, string>): PageGaps {
  const page = store.getPage(pageId)!;
  const designSystemId = sharedDesignSystemIdOf(store, pageId);
  const designSystemTitle = (designSystemId && store.getDesignSystem(designSystemId)?.title) || "";
  if (designSystemId === undefined || store.isDesignSystemProject(page.projectId)) return { designSystemTitle, gaps: [] };
  const manifestText = files[MANIFEST_PATH];
  const artboards = (manifestText === undefined ? defaultManifest(Object.keys(files)) : parseManifest(manifestText)).artboards;
  const context = gapContext(store, designSystemId, page.projectId);
  const gaps = artboards
    .filter((a) => files[a.file] !== undefined && componentNameOf(a.file) === null)
    .flatMap((a) => analyseGaps(a.file, files[a.file], context));
  return { designSystemTitle, gaps };
}

/** The gaps of the latest version of a page. */
export function pageGaps(store: Store, pageId: string): PageGaps {
  return gapsOfFiles(store, pageId, store.readPageFiles(pageId)?.files ?? {});
}

/** What a session is told about its artboards: the gaps of `files`, without those the user marked as exceptions. */
export function agentGaps(store: Store, pageId: string, files: Record<string, string>): PageGaps {
  const exceptions = new Set(store.getViewSettings(pageId).gapExceptions);
  const { designSystemTitle, gaps } = gapsOfFiles(store, pageId, files);
  return { designSystemTitle, gaps: gaps.filter((gap) => !exceptions.has(gap.key)) };
}

export function registerGapRoutes(app: FastifyInstance, store: Store): void {
  app.get<{ Params: { pageId: string } }>(pageGapsPath(":pageId"), async (req, reply): Promise<PageGaps> => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return pageGaps(store, req.params.pageId);
  });
}
