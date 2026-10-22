import { useEffect, useState, type ChangeEvent } from "react";
import type { DesignMdResponse, Project, ProjectAsset, SaveDesignMdRequest } from "@redline/shared";
import { routeHref } from "./router.js";

export function DesignMdScreen({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [assets, setAssets] = useState<ProjectAsset[]>([]);

  const loadAssets = () =>
    fetch(`/api/projects/${projectId}/assets`)
      .then((res) => res.json() as Promise<ProjectAsset[]>)
      .then(setAssets);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json() as Promise<Project>)
      .then(setProject);
    fetch(`/api/projects/${projectId}/design-md`)
      .then((res) => res.json() as Promise<DesignMdResponse>)
      .then(({ content }) => {
        setSaved(content);
        setText(content);
      });
    void loadAssets();
  }, [projectId]);

  if (!project || saved === null) return <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>Chargement…</main>;

  const dirty = text !== saved;

  async function save() {
    const body: SaveDesignMdRequest = { content: text };
    await fetch(`/api/projects/${projectId}/design-md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaved(text);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of files) {
      await fetch(`/api/projects/${projectId}/assets/${file.name.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
    }
    await loadAssets();
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <nav>
        <a href={routeHref({ name: "projects" })}>Projets</a> /{" "}
        <a href={routeHref({ name: "project", projectId })}>{project.title}</a> / DESIGN.md
      </nav>
      <h1>DESIGN.md</h1>
      <p>Ce fichier s'applique à toutes les sessions du projet. Une règle modifiée ici vaut dès le prochain commentaire ou message.</p>
      <textarea
        aria-label="Contenu de DESIGN.md"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ display: "block", width: "100%", minHeight: 320, fontFamily: "ui-monospace, monospace" }}
      />
      <p>
        <span data-testid="design-md-status">{dirty ? "Modifications non enregistrées" : "Enregistré"}</span>{" "}
        <button onClick={save} disabled={!dirty}>
          Enregistrer
        </button>
      </p>
      <h2>Assets du projet</h2>
      <p>Images et polices partagées par tous les artboards du projet. À utiliser comme <code>assets/&lt;nom&gt;</code>.</p>
      <label>
        Ajouter des assets <input type="file" multiple onChange={upload} />
      </label>
      {assets.length === 0 && <p>Aucun asset pour l'instant.</p>}
      <ul data-testid="assets">
        {assets.map((asset) => (
          <li key={asset.name}>
            {asset.name} <small>{asset.size} octets</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
