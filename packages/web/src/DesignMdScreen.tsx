import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { DesignMdResponse, DesignMdVersion, Project, ProjectAsset, SaveDesignMdRequest } from "@redline/shared";
import { ruleOrigins } from "./designMdRules.js";
import { relativeTime } from "./relativeTime.js";
import { routeHref } from "./router.js";
import { Button, Dialog, Logo, cx } from "./ui/index.js";
import styles from "./DesignMdScreen.module.css";

const plural = (count: number) => `${count} ${count <= 1 ? "version" : "versions"}`;

function HistoryDialog({ versions, onRestore, onClose }: { versions: DesignMdVersion[]; onRestore: (version: DesignMdVersion) => void; onClose: () => void }) {
  return (
    <Dialog title="Historique de DESIGN.md" onClose={onClose} width={520}>
      <ol className={styles.versions}>
        {versions.map((version, index) => (
          <li key={version.id} className={styles.version}>
            <span className={styles.versionText}>
              <span>{relativeTime(version.createdAt)}</span>
              <span className={styles.versionMeta}>
                Toi · {version.content.split("\n").length} lignes
              </span>
            </span>
            {index === 0 ? (
              <span className={styles.versionMeta}>Actuelle</span>
            ) : (
              <Button size="sm" onClick={() => onRestore(version)}>
                Restaurer
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

export function DesignMdScreen({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const [versions, setVersions] = useState<DesignMdVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);

  const loadAssets = () =>
    fetch(`/api/projects/${projectId}/assets`)
      .then((res) => res.json() as Promise<ProjectAsset[]>)
      .then(setAssets);
  const loadVersions = () =>
    fetch(`/api/projects/${projectId}/design-md/versions`)
      .then((res) => res.json() as Promise<DesignMdVersion[]>)
      .then(setVersions);

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
    void loadVersions();
  }, [projectId]);

  if (!project || saved === null) return <main className={styles.screen}>Chargement…</main>;

  const dirty = text !== saved;
  const latest = versions[0];
  const status = dirty
    ? "Modifications non enregistrées"
    : justSaved
      ? "Enregistré"
      : latest
        ? `Dernière modification par toi · ${relativeTime(latest.createdAt)}`
        : "";

  async function save() {
    const body: SaveDesignMdRequest = { content: text };
    await fetch(`/api/projects/${projectId}/design-md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaved(text);
    setJustSaved(true);
    await loadVersions();
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

  function restore(version: DesignMdVersion) {
    setText(version.content);
    setJustSaved(false);
    setHistoryOpen(false);
  }

  const rules = ruleOrigins(text, versions);

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <a href={routeHref({ name: "home" })} aria-label="Accueil" className={styles.logoLink}>
          <Logo />
        </a>
        <nav aria-label="Fil d'Ariane" className={styles.breadcrumb}>
          <a href={routeHref({ name: "projects" })}>Projets</a>
          <span aria-hidden="true">/</span>
          <a href={routeHref({ name: "project", projectId })}>{project.title}</a>
          <span aria-hidden="true">/</span>
          <span className={styles.current}>DESIGN.md</span>
        </nav>
        <div className={styles.grow} />
        <div data-testid="design-md-status" className={cx(styles.status, dirty && styles.statusDirty)}>
          {status}
        </div>
        <a href={routeHref({ name: "project", projectId })} className={styles.closeLink}>
          Fermer
        </a>
        <button type="button" className={styles.save} onClick={save} disabled={!dirty}>
          Enregistrer
        </button>
      </header>

      <div className={styles.body}>
        <main className={styles.editor}>
          <div className={styles.notice}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5" />
              <path d="M12 16h.01" />
            </svg>
            Ce fichier s'applique à toutes les sessions du projet. Une règle modifiée ici vaut dès le prochain commentaire ou message.
          </div>
          <label htmlFor="design-md" className={styles.srOnly}>
            Contenu de DESIGN.md
          </label>
          <textarea
            id="design-md"
            className={styles.textarea}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setJustSaved(false);
            }}
          />
        </main>

        <aside aria-label="Origine des règles" className={styles.side}>
          <div className={styles.sideIntro}>
            <h2 className={styles.sideTitle}>Origine des règles</h2>
            <div className={styles.sideText}>D'où vient chaque règle, pour savoir quoi corriger si l'une d'elles est mal comprise.</div>
          </div>

          {rules.length === 0 ? (
            <div className={styles.sideText}>Aucune règle pour l'instant : les lignes qui commencent par « - » apparaissent ici.</div>
          ) : (
            <ul data-testid="rules" className={styles.rules}>
              {rules.map(({ rule, createdAt }, index) => (
                <li key={index} className={styles.rule}>
                  <div className={styles.ruleText}>{rule}</div>
                  <div className={styles.ruleOrigin}>Toi · {createdAt ? relativeTime(createdAt) : "pas encore enregistrée"}</div>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.grow} />

          <div className={styles.block}>
            <h2 className={styles.blockTitle}>Assets du projet</h2>
            <div className={styles.blockText}>
              Images et polices partagées par tous les artboards. À utiliser comme <code>assets/&lt;nom&gt;</code>.
            </div>
            <input ref={fileInput} type="file" multiple hidden onChange={upload} />
            <Button size="sm" onClick={() => fileInput.current?.click()} className={styles.upload}>
              Ajouter des assets
            </Button>
            {assets.length === 0 && <div className={styles.blockText}>Aucun asset pour l'instant.</div>}
            <ul data-testid="assets" className={styles.assets}>
              {assets.map((asset) => (
                <li key={asset.name}>
                  {asset.name} <span className={styles.assetSize}>{asset.size} octets</span>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.block}>
            <div className={styles.blockHeader}>
              <h2 className={styles.blockTitle}>Historique</h2>
              {versions.length > 0 ? (
                <button type="button" className={styles.linkButton} onClick={() => setHistoryOpen(true)}>
                  {plural(versions.length)}
                </button>
              ) : (
                <span className={styles.sideText}>Aucune version</span>
              )}
            </div>
            <div className={styles.blockText}>Chaque modification, par toi ou par Claude, crée une version : tu peux revenir à n'importe laquelle.</div>
          </div>
        </aside>
      </div>

      {historyOpen && <HistoryDialog versions={versions} onRestore={restore} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
