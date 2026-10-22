import { useEffect, useState } from "react";
import { PageCanvas } from "./PageCanvas.js";

interface Project {
  id: string;
  title: string;
}
interface Page {
  id: string;
  title: string;
  version: { files: Record<string, string> };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json() as Promise<T>;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [artboardOrigin, setArtboardOrigin] = useState("");

  useEffect(() => {
    getJson<{ artboardOrigin: string }>("/api/config").then((c) => setArtboardOrigin(c.artboardOrigin));
    getJson<Project[]>("/api/projects").then(async (list) => {
      setProjects(list);
      const all = await Promise.all(list.map((p) => getJson<Page[]>(`/api/projects/${p.id}/pages`)));
      setPages(all.flat());
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
          <PageCanvas
            pageId={page.id}
            pageTitle={page.title}
            artboards={Object.keys(page.version.files).filter((path) => path.endsWith(".html"))}
            artboardOrigin={artboardOrigin}
          />
        </section>
      ))}
    </main>
  );
}
