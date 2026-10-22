import { useEffect, useState, type FormEvent } from "react";
import { starterPageFiles, type CreatePageRequest, type Page, type PageType, type Project } from "@redline/shared";
import { Dialog } from "./Dialog.js";
import { PageThumbnail } from "./PageThumbnail.js";
import { agentLabel } from "./agentLabel.js";
import { routeHref } from "./router.js";

function NewPageDialog({
  projectId,
  designSystem,
  onClose,
  onCreated,
}: {
  projectId: string;
  designSystem: string | null;
  onClose: () => void;
  onCreated: (page: Page) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<PageType>("prototype");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const pageTitle = title.trim();
    const body: CreatePageRequest = { title: pageTitle, type, files: starterPageFiles(pageTitle, type, designSystem) };
    const res = await fetch(`/api/projects/${projectId}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    onCreated((await res.json()) as Page);
  }

  return (
    <Dialog title="New page" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required style={{ display: "block", width: "100%" }} />
        </label>
        <fieldset>
          <legend>Type</legend>
          <label>
            <input type="radio" name="type" checked={type === "prototype"} onChange={() => setType("prototype")} />
            Prototype
          </label>{" "}
          <small>Chain screens into a flow.</small>
          <br />
          <label>
            <input type="radio" name="type" checked={type === "comparison"} onChange={() => setType("comparison")} />
            Comparison
          </label>{" "}
          <small>Compare variants side by side.</small>
        </fieldset>
        <div>
          <button type="button" onClick={onClose}>
            Cancel
          </button>{" "}
          <button type="submit" disabled={title.trim() === ""}>
            Create page
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectOverview({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [artboardOrigin, setArtboardOrigin] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json() as Promise<{ artboardOrigin: string }>)
      .then((config) => setArtboardOrigin(config.artboardOrigin));
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json() as Promise<Project>)
      .then(setProject);
    fetch(`/api/projects/${projectId}/pages`)
      .then((res) => res.json() as Promise<Page[]>)
      .then(setPages);
  }, [projectId]);

  if (!project) return <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>Loading…</main>;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <nav>
        <a href={routeHref({ name: "projects" })}>Projects</a>
      </nav>
      <h1>{project.title}</h1>
      <p data-testid="project-agent">{agentLabel(project)}</p>
      <label>
        <input
          type="checkbox"
          checked={project.allowGlobalTakeover}
          onChange={async (event) => {
            const res = await fetch(`/api/projects/${projectId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ allowGlobalTakeover: event.target.checked }),
            });
            setProject((await res.json()) as Project);
          }}
        />
        Let the global agent take over when the project agent is offline
      </label>{" "}
      <small>Threads then restart in a new session, without the project's context.</small>
      <br />
      <a href={routeHref({ name: "designMd", projectId })}>DESIGN.md</a>{" "}
      <button onClick={() => setCreating(true)}>New page</button>
      {pages.length === 0 && <p>No page yet.</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexWrap: "wrap", gap: 16 }}>
        {pages.map((page) => (
          <li key={page.id}>
            <a href={routeHref({ name: "page", pageId: page.id })} style={{ textDecoration: "none", color: "inherit" }}>
              <PageThumbnail pageId={page.id} files={page.version.files} artboardOrigin={artboardOrigin} />
              <div>
                <strong>{page.title}</strong> <small>{page.type}</small>
              </div>
            </a>
          </li>
        ))}
      </ul>
      {creating && (
        <NewPageDialog
          projectId={projectId}
          designSystem={project.designSystem}
          onClose={() => setCreating(false)}
          onCreated={(page) => {
            window.location.hash = routeHref({ name: "page", pageId: page.id });
          }}
        />
      )}
    </main>
  );
}
