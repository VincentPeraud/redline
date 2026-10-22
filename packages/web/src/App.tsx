import { useEffect, useState } from "react";
import type { Project, VersionOrigin } from "@redline/shared";
import { PageCanvas } from "./PageCanvas.js";
import { routeHref } from "./router.js";
import { subscribeServerEvents } from "./serverEvents.js";

const ORIGIN_LABEL: Record<VersionOrigin, string> = {
  creation: "Création",
  thread: "Commentaire",
  conversation: "Conversation",
  terminal: "Terminal",
  tweak: "Tweak",
  restore: "Restauration",
};

interface Page {
  id: string;
  projectId: string;
  title: string;
  version: { id: string; files: Record<string, string> };
}
interface VersionSummary {
  id: string;
  message: string;
  origin: string;
  createdAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json() as Promise<T>;
}

function VersionHistory({ page, onRestored }: { page: Page; onRestored: () => void }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);

  useEffect(() => {
    getJson<VersionSummary[]>(`/api/pages/${page.id}/versions`).then(setVersions);
  }, [page.id, page.version.id]);

  async function restore(versionId: string) {
    await fetch(`/api/pages/${page.id}/versions/${versionId}/restore`, { method: "POST" });
    onRestored();
  }

  return (
    <ol aria-label={`Versions de ${page.title}`}>
      {versions.map((version) => (
        <li key={version.id}>
          <span>{version.message}</span> <small>{ORIGIN_LABEL[version.origin as VersionOrigin] ?? version.origin}</small>{" "}
          {version.id === page.version.id ? (
            <em>actuelle</em>
          ) : (
            <button onClick={() => restore(version.id)}>Restaurer</button>
          )}
        </li>
      ))}
    </ol>
  );
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
      }),
    [pageId],
  );

  if (!page) return <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>Chargement…</main>;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <nav>
        <a href={routeHref({ name: "projects" })}>Projets</a>
        {project && (
          <>
            {" / "}
            <a href={routeHref({ name: "project", projectId: project.id })}>{project.title}</a>
          </>
        )}
      </nav>
      <section>
        <h1>{page.title}</h1>
        <button onClick={() => setHistoryOpen(!historyOpen)}>Historique</button>
        {historyOpen && <VersionHistory page={page} onRestored={loadPage} />}
        <PageCanvas
          pageId={page.id}
          pageTitle={page.title}
          files={page.version.files}
          artboardOrigin={artboardOrigin}
          versionId={page.version.id}
          onVersionChange={loadPage}
        />
      </section>
    </main>
  );
}
