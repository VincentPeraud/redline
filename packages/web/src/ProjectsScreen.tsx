import { useEffect, useState, type FormEvent } from "react";
import { NEUTRAL_DESIGN_SYSTEM_ID, type CreateProjectRequest, type DesignSystemSummary, type Project } from "@redline/shared";
import { agentLabel } from "./agentLabel.js";
import { Dialog } from "./Dialog.js";
import { usedByLabel } from "./designSystemLabel.js";
import { routeHref } from "./router.js";

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [designSystem, setDesignSystem] = useState("");
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: CreateProjectRequest = {
      title: title.trim(),
      instructions: instructions.trim(),
      designSystem: designSystem || null,
    };
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    onCreated((await res.json()) as Project);
  }

  return (
    <Dialog title="Nouveau projet" onClose={onClose}>
      <p>
        Conseillé : partir d'un dossier de code. Lance <code>redline agent</code> dans le dossier de ton projet pour le
        lier à un projet existant ou en créer un.
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label>
          Titre
          <input value={title} onChange={(e) => setTitle(e.target.value)} required style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          Instructions pour Claude (facultatif)
          <textarea
            aria-label="Instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Design system
          <select value={designSystem} onChange={(e) => setDesignSystem(e.target.value)} style={{ display: "block" }}>
            <option value="">Neutre (par défaut)</option>
            {designSystems
              .filter((ds) => ds.id !== NEUTRAL_DESIGN_SYSTEM_ID)
              .map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.title}
                  {ds.usedBy.length > 0 && ` — ${usedByLabel(ds)}`}
                </option>
              ))}
          </select>
        </label>
        <div>
          <button type="button" onClick={onClose}>
            Annuler
          </button>{" "}
          <button type="submit" disabled={title.trim() === ""}>
            Créer le projet
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectsScreen() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json() as Promise<Project[]>)
      .then(setProjects);
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Redline</h1>
      <h2>Projets</h2>
      <button onClick={() => setCreating(true)}>Nouveau projet</button>
      {projects?.length === 0 && <p>Aucun projet pour l'instant.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {projects?.map((project) => (
          <li key={project.id}>
            <a href={routeHref({ name: "project", projectId: project.id })}>{project.title}</a>
            <small data-testid="project-agent"> {agentLabel(project)}</small>
          </li>
        ))}
      </ul>
      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            window.location.hash = routeHref({ name: "project", projectId: project.id });
          }}
        />
      )}
    </main>
  );
}
