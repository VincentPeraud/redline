import { useEffect, useState } from "react";
import type { PageViewSettings, Project } from "@redline/shared";
import { PageCanvas } from "./PageCanvas.js";
import type { PageRoute } from "./router.js";
import { subscribeServerEvents } from "./serverEvents.js";

interface Page {
  id: string;
  projectId: string;
  title: string;
  version: { id: string; files: Record<string, string> };
  viewSettings: PageViewSettings;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json() as Promise<T>;
}

export function App({ route }: { route: PageRoute }) {
  const { pageId } = route;
  const [page, setPage] = useState<Page | null>(null);
  const [project, setProject] = useState<Project | null>(null);
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
  }, [page?.projectId, page?.designSystem]);

  useEffect(
    () =>
      subscribeServerEvents((event) => {
        if (event.type === "page-updated" && event.pageId === pageId) void loadPage();
        if (event.type === "agents-updated" && page && !page.designSystem) void getJson<Project>(`/api/projects/${page.projectId}`).then(setProject);
      }),
    [pageId, page?.projectId],
  );

  if (!page) return <main style={{ padding: 24 }}>Chargement…</main>;

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
      />
    </>
  );
}
