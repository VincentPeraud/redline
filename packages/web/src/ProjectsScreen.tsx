import { useEffect, useState, type FormEvent } from "react";
import { NEUTRAL_DESIGN_SYSTEM_ID, type CreateProjectRequest, type DesignSystem, type Project } from "@redline/shared";
import { agentLabel } from "./agentLabel.js";
import { Dialog } from "./Dialog.js";
import { routeHref } from "./router.js";

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [designSystem, setDesignSystem] = useState("");
  const [designSystems, setDesignSystems] = useState<DesignSystem[]>([]);

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystem[]>)
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
    <Dialog title="New project" onClose={onClose}>
      <p>
        Recommended: start from a code folder. Run <code>redline agent</code> in your project folder to link it to a
        project or create one.
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          Instructions for Claude (optional)
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
            <option value="">Neutral (default)</option>
            {designSystems
              .filter((ds) => ds.id !== NEUTRAL_DESIGN_SYSTEM_ID)
              .map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.title}
                </option>
              ))}
          </select>
        </label>
        <div>
          <button type="button" onClick={onClose}>
            Cancel
          </button>{" "}
          <button type="submit" disabled={title.trim() === ""}>
            Create project
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
      <nav>
        <a href={routeHref({ name: "agents" })}>Agents</a>
      </nav>
      <h2>Projects</h2>
      <button onClick={() => setCreating(true)}>New project</button>
      {projects?.length === 0 && <p>No project yet.</p>}
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
