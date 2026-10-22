import { useEffect, useState, type FormEvent } from "react";
import {
  type CreateDesignSystemRequest,
  type DesignSystem,
  type DesignSystemSummary,
  type Project,
} from "@redline/shared";
import { Dialog } from "./Dialog.js";
import { usedByLabel } from "./designSystemLabel.js";
import { routeHref } from "./router.js";

function NewDesignSystemDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (designSystem: DesignSystem) => void }) {
  const [title, setTitle] = useState("");
  const [fromProjectId, setFromProjectId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json() as Promise<Project[]>)
      .then(setProjects);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: CreateDesignSystemRequest = {
      title: title.trim(),
      ...(fromProjectId ? { fromProjectId } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    };
    const res = await fetch("/api/design-systems", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    onCreated((await res.json()) as DesignSystem);
  }

  return (
    <Dialog title="Ajouter un design system" onClose={onClose}>
      <p>
        Le design system est créé avec le socle de variables commun (<code>--color-primary</code>, <code>--font-heading</code>…), que
        Claude remplit. Tu peux lui demander de s'inspirer du code d'un projet : son agent de projet y a accès.
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label>
          Nom
          <input value={title} onChange={(e) => setTitle(e.target.value)} required style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          Partir des pages d'un projet (facultatif)
          <select value={fromProjectId} onChange={(e) => setFromProjectId(e.target.value)} style={{ display: "block" }}>
            <option value="">Aucun, partir de zéro</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        {fromProjectId && <small>Claude reprend les couleurs, la typo et les composants déjà utilisés dans ce projet.</small>}
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
        <small>Si tu en donnes, ce sera le premier message de la première conversation du design system.</small>
        <div>
          <button type="button" onClick={onClose}>
            Annuler
          </button>{" "}
          <button type="submit" disabled={title.trim() === ""}>
            Créer le design system
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function DesignSystemsScreen() {
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <nav>
        <a href={routeHref({ name: "projects" })}>Projets</a>
      </nav>
      <h1>Design systems</h1>
      <p>
        Un design system est un projet comme les autres : sa page principale sert d'aperçu, et tu le fais évoluer en commentant ses
        pages.
      </p>
      <button onClick={() => setCreating(true)}>Ajouter un design system</button>
      <ul style={{ listStyle: "none", padding: 0 }} data-testid="design-systems">
        {designSystems?.map((ds) => (
          <li key={ds.id} data-testid="design-system">
            <a href={routeHref({ name: "page", pageId: ds.pageId })}>{ds.title}</a> <small>{usedByLabel(ds)}</small>
          </li>
        ))}
      </ul>
      {creating && (
        <NewDesignSystemDialog
          onClose={() => setCreating(false)}
          onCreated={(ds) => {
            window.location.hash = routeHref({ name: "page", pageId: ds.pageId });
          }}
        />
      )}
    </main>
  );
}
