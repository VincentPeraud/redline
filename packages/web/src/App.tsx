import { useEffect, useState } from "react";
import { PageCanvas } from "./PageCanvas.js";

interface Project {
  id: string;
  title: string;
}
interface Page {
  id: string;
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
    <ol aria-label={`Versions of ${page.title}`}>
      {versions.map((version) => (
        <li key={version.id}>
          <span>{version.message}</span> <small>{version.origin}</small>{" "}
          {version.id === page.version.id ? (
            <em>current</em>
          ) : (
            <button onClick={() => restore(version.id)}>Restore</button>
          )}
        </li>
      ))}
    </ol>
  );
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [artboardOrigin, setArtboardOrigin] = useState("");
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);

  async function loadPages(list: Project[]) {
    const all = await Promise.all(list.map((p) => getJson<Page[]>(`/api/projects/${p.id}/pages`)));
    setPages(all.flat());
  }

  useEffect(() => {
    getJson<{ artboardOrigin: string }>("/api/config").then((c) => setArtboardOrigin(c.artboardOrigin));
    getJson<Project[]>("/api/projects").then(async (list) => {
      setProjects(list);
      await loadPages(list);
    });
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Redline</h1>
      {projects.map((project) => (
        <section key={project.id}>
          <h2>{project.title}</h2>
        </section>
      ))}
      {pages.map((page) => (
        <section key={page.id}>
          <h3>{page.title}</h3>
          <button onClick={() => setHistoryOpen(historyOpen === page.id ? null : page.id)}>History</button>
          {historyOpen === page.id && <VersionHistory page={page} onRestored={() => loadPages(projects)} />}
          <PageCanvas
            pageId={page.id}
            pageTitle={page.title}
            files={page.version.files}
            artboardOrigin={artboardOrigin}
            versionId={page.version.id}
          />
        </section>
      ))}
    </main>
  );
}
