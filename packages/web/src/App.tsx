import { useEffect, useState } from "react";
import type { Project } from "@redline/shared";
import { PageCanvas } from "./PageCanvas.js";
import { VersionHistory } from "./VersionHistory.js";
import { subscribeServerEvents } from "./serverEvents.js";

interface Page {
  id: string;
  projectId: string;
  title: string;
  version: { id: string; files: Record<string, string> };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json() as Promise<T>;
}

export function App({ pageId }: { pageId: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [artboardOrigin, setArtboardOrigin] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  async function loadPage() {
    setPage(await getJson<Page>(`/api/pages/${pageId}`));
  }

  useEffect(() => {
    getJson<{ artboardOrigin: string }>("/api/config").then((c) => setArtboardOrigin(c.artboardOrigin));
    void loadPage();
  }, [pageId]);

  useEffect(() => {
    if (page) getJson<Project>(`/api/projects/${page.projectId}`).then(setProject);
  }, [page?.projectId]);

  useEffect(
    () =>
      subscribeServerEvents((event) => {
        if (event.type === "page-updated" && event.pageId === pageId) void loadPage();
        if (event.type === "agents-updated" && page) void getJson<Project>(`/api/projects/${page.projectId}`).then(setProject);
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
        files={page.version.files}
        artboardOrigin={artboardOrigin}
        versionId={page.version.id}
        onVersionChange={loadPage}
        onOpenHistory={() => setHistoryOpen(true)}
      />
      {historyOpen && (
        <VersionHistory pageId={page.id} pageTitle={page.title} versionId={page.version.id} onRestored={loadPage} onClose={() => setHistoryOpen(false)} />
      )}
    </>
  );
}
