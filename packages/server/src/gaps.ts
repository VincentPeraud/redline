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
import { designSystemIdOf } from "./project-files.js";
import type { Store } from "./store.js";

/** Tokens and components a page's artboards can use: the design system's current diffusion with the project's own style over it. */
function gapContext(store: Store, pageId: string, projectId: string): GapContext {
  const designSystemId = designSystemIdOf(store, pageId);
  const diffusion = store.currentDiffusion(designSystemId);
  const read = (file: Parameters<Store["readDiffusionFile"]>[2]) => (diffusion ? store.readDiffusionFile(designSystemId, diffusion.number, file) : undefined);

  const tokens = new Map(parseTokens(read("tokens.css") ?? "").map((t) => [t.name, t]));
  for (const token of parseTokens(store.readProjectFile(projectId, PROJECT_STYLE_PATH)?.toString("utf8") ?? "")) tokens.set(token.name, token);

  const sharedFiles = JSON.parse(read("component-files.json") ?? "{}") as Record<string, string>;
  const components = new Map<string, string[]>();
  for (const [path, content] of [...Object.entries(sharedFiles), ...Object.entries(componentFilesOf(store, projectId))]) {
    components.set(componentNameOf(path)!, componentClassesOf(content));
  }
  return { tokens: [...tokens.values()], components: [...components].map(([name, classes]) => ({ name, classes })) };
}

/** The gaps of the latest version of a page; none on a design system's own pages, which are the system. */
export function pageGaps(store: Store, pageId: string): PageGaps {
  const page = store.getPage(pageId)!;
  const designSystemTitle = store.getDesignSystem(designSystemIdOf(store, pageId))?.title ?? "";
  if (store.isDesignSystemProject(page.projectId)) return { designSystemTitle, gaps: [] };
  const files = store.readPageFiles(pageId)?.files ?? {};
  const manifestText = files[MANIFEST_PATH];
  const artboards = (manifestText === undefined ? defaultManifest(Object.keys(files)) : parseManifest(manifestText)).artboards;
  const context = gapContext(store, pageId, page.projectId);
  const gaps = artboards
    .filter((a) => files[a.file] !== undefined && componentNameOf(a.file) === null)
    .flatMap((a) => analyseGaps(a.file, files[a.file], context));
  return { designSystemTitle, gaps };
}

export function registerGapRoutes(app: FastifyInstance, store: Store): void {
  app.get<{ Params: { pageId: string } }>(pageGapsPath(":pageId"), async (req, reply): Promise<PageGaps> => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return pageGaps(store, req.params.pageId);
  });
}
