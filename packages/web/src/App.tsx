import { useArtboardOrigin } from "./artboardCapability.js";
import { useEffect, useState } from "react";
import type { ArchiveStatus, CommentMode, PageViewSettings, Project } from "@redline/shared";
import { PageCanvas } from "./PageCanvas.js";
import type { PageRoute } from "./router.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { useDocumentTitle } from "./documentTitle.js";
import { showToast } from "./toasts.js";
import { useMe } from "./useMe.js";

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
  commentMode: CommentMode;
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
  const artboardOrigin = useArtboardOrigin(page?.projectId);
  const me = useMe();

  async function loadPage() {
    setPage(await getJson<Page>(`/api/pages/${pageId}`));
  }

  useEffect(() => {
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
        if (event.type === "comment-mode-changed" && event.pageId === pageId) {
          void loadPage();
          // The person who switched sees their own result; the others are told, once, who changed it.
          if (event.by && event.by.id !== me?.id) {
            const who = event.by.name || event.by.email;
            showToast({
              message: event.mode === "agent" ? `${who} a passé la page en mode Agent : les nouveaux commentaires partent à l'agent.` : `${who} a passé la page en mode Conversation : les nouveaux commentaires attendent qu'une conversation les prenne.`,
            });
          }
        }
        if (event.type === "agents-updated" && page && !page.designSystem) void getJson<Project>(`/api/projects/${page.projectId}`).then(setProject);
      }, () => {
        void loadPage();
        setReloads((count) => count + 1);
      }),
    [pageId, page?.projectId, me?.id],
  );

  // A design system's own page has no project of the API: its tab shows the page alone.
  useDocumentTitle(page?.title, page?.designSystem ? null : project?.title);

  if (!page || !artboardOrigin) return <main style={{ padding: 24 }}>Chargement…</main>;

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
        commentMode={page.commentMode}
        onCommentModeChange={loadPage}
      />
    </>
  );
}
