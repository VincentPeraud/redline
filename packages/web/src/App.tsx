import { useEffect, useState } from "react";
import type { ArchiveStatus, PageViewSettings, Project } from "@redline/shared";
import { PageCanvas } from "./PageCanvas.js";
import type { PageRoute } from "./router.js";
import { subscribeServerEvents } from "./serverEvents.js";

interface Page {
  id: string;
  projectId: string;
  title: string;
  version: { id: string; files: Record<string, string> };
  viewSettings: PageViewSettings;
  /** The page belongs to a design system's own project. */
  designSystem?: boolean;
  /** The page itself is archived. */
  archivedAt?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json() as Promise<T>;
}

export function App({ route }: { route: PageRoute }) {
  const { pageId } = route;
  const [page, setPage] = useState<Page | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  /** When the page's design system is archived (a design system's own page): read-only like an archived project's. */
  const [designSystemArchivedAt, setDesignSystemArchivedAt] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  const [artboardOrigin, setArtboardOrigin] = useState("");

  async function loadPage() {
    setPage(await getJson<Page>(`/api/pages/${pageId}`));
  }

  useEffect(() => {
    getJson<{ artboardOrigin: string }>("/api/config").then((c) => setArtboardOrigin(c.artboardOrigin));
    void loadPage();
  }, [pageId]);

  useEffect(() => {
    // A design system's own project is not a project of the API.
    if (page && !page.designSystem) getJson<Project>(`/api/projects/${page.projectId}`).then(setProject);
    if (page?.designSystem) getJson<ArchiveStatus>(`/api/projects/${page.projectId}/archive`).then((status) => setDesignSystemArchivedAt(status.archivedAt));
  }, [page?.projectId, page?.designSystem, reloads]);

  useEffect(
    () =>
      subscribeServerEvents((event) => {
        if ((event.type === "page-updated" || event.type === "page-renamed" || event.type === "page-archive-changed") && event.pageId === pageId) void loadPage();
        if (event.type === "agents-updated" && page && !page.designSystem) void getJson<Project>(`/api/projects/${page.projectId}`).then(setProject);
      }),
    [pageId, page?.projectId],
  );

  if (!page) return <main style={{ padding: 24 }}>Chargement…</main>;

  // An archived project or design system wins over an archived page: unarchiving the page alone would not make it writable.
  const archivedAt = page.designSystem ? designSystemArchivedAt : project?.archivedAt;
  const archived = archivedAt
    ? { kind: page.designSystem ? ("designSystem" as const) : ("project" as const), archivedAt, onUnarchived: () => setReloads((count) => count + 1) }
    : page.archivedAt && project
      ? { kind: "page" as const, archivedAt: page.archivedAt, onUnarchived: () => void loadPage() }
      : undefined;

  return (
    <>
      <PageCanvas
        pageId={page.id}
        pageTitle={page.title}
        project={project}
        projectId={page.projectId}
        designSystemPage={page.designSystem ?? false}
        files={page.version.files}
        artboardOrigin={artboardOrigin}
        versionId={page.version.id}
        onVersionChange={loadPage}
        viewSettings={page.viewSettings}
        route={route}
        archived={archived}
      />
    </>
  );
}
