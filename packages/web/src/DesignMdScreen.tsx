import { useEffect, useState } from "react";
import type { DesignMdInfo, DesignMdResponse, DesignMdVersion, Project, SaveDesignMdRequest } from "@redline/shared";
import { rulesToShow } from "./designMdRules.js";
import { dayLabel, designMdStatus, metaLine, originLabel, ruleOrigin } from "./historyLabels.js";
import { useWho } from "./useMe.js";
import { relativeTime } from "./relativeTime.js";
import { routeHref, type Route } from "./router.js";
import { Button, Dialog, Logo, cx } from "./ui/index.js";
import styles from "./DesignMdScreen.module.css";
import { useDocumentTitle } from "./documentTitle.js";

const plural = (count: number) => `${count} ${count <= 1 ? "version" : "versions"}`;

function HistoryDialog({ versions, onRestore, onClose }: { versions: DesignMdVersion[]; onRestore: (version: DesignMdVersion) => void; onClose: () => void }) {
  const who = useWho();
  return (
    <Dialog title="Historique de DESIGN.md" onClose={onClose} width={520}>
      <ol className={styles.versions}>
        {versions.map((version, index) => (
          <li key={version.id} className={styles.version}>
            <span className={styles.versionText}>
              <span>{relativeTime(version.createdAt)}</span>
              <span className={styles.versionMeta}>
                {metaLine(originLabel(version.origin, version.originLabel, who(version.person)), `${version.content.split("\n").length} lignes`)}
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
  const who = useWho();
  /** Whose DESIGN.md it is: a project, or a design system (same id space, reached from its overview). */
  const [owner, setOwner] = useState<{ title: string; designSystem: boolean } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const [versions, setVersions] = useState<DesignMdVersion[]>([]);
  const [info, setInfo] = useState<DesignMdInfo | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadVersions = () =>
    Promise.all([
      fetch(`/api/projects/${projectId}/design-md/versions`).then((res) => res.json() as Promise<DesignMdVersion[]>),
      fetch(`/api/projects/${projectId}/design-md/info`).then((res) => res.json() as Promise<DesignMdInfo>),
    ]).then(([list, loaded]) => {
      setVersions(list);
      setInfo(loaded);
    });

  useEffect(() => {
    void (async () => {
      const designSystem = await fetch(`/api/design-systems/${projectId}`);
      if (designSystem.ok) return setOwner({ title: ((await designSystem.json()) as { title: string }).title, designSystem: true });
      const project = (await (await fetch(`/api/projects/${projectId}`)).json()) as Project;
      setOwner({ title: project.title, designSystem: false });
    })();
    fetch(`/api/projects/${projectId}/design-md`)
      .then((res) => res.json() as Promise<DesignMdResponse>)
      .then(({ content }) => {
        setSaved(content);
        setText(content);
      });
    void loadVersions();
  }, [projectId]);

  useDocumentTitle("DESIGN.md", owner?.title);

  if (!owner || saved === null) return <main className={styles.screen}>Chargement…</main>;

  const dirty = text !== saved;
  const latest = info?.lastModified;
  const status = dirty
    ? "Modifications non enregistrées"
    : justSaved
      ? "Enregistré"
      : latest
        ? designMdStatus(latest.origin, latest.originLabel, dayLabel(latest.createdAt), who(latest.person))
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

  function restore(version: DesignMdVersion) {
    setText(version.content);
    setJustSaved(false);
    setHistoryOpen(false);
  }

  const rules = rulesToShow(text, info?.rules ?? []);
  const back: Route = owner.designSystem ? { name: "designSystem", designSystemId: projectId } : { name: "project", projectId };
  const firstVersionId = versions[versions.length - 1]?.id;

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <a href={routeHref({ name: "home" })} aria-label="Accueil" className={styles.logoLink}>
          <Logo />
        </a>
        <nav aria-label="Fil d'Ariane" className={styles.breadcrumb}>
          <a href={routeHref(owner.designSystem ? { name: "designSystems" } : { name: "projects" })}>{owner.designSystem ? "Design systems" : "Projets"}</a>
          <span aria-hidden="true">/</span>
          <a href={routeHref(back)}>{owner.title}</a>
          <span aria-hidden="true">/</span>
          <span className={styles.current}>DESIGN.md</span>
        </nav>
        <div className={styles.grow} />
        <div data-testid="design-md-status" className={cx(styles.status, dirty && styles.statusDirty)}>
          {status}
        </div>
        <a href={routeHref(back)} className={styles.closeLink}>
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
            <div className={styles.sideText}>Aucune règle pour l'instant : chaque ligne du fichier apparaît ici avec son origine.</div>
          ) : (
            <ul data-testid="rules" className={styles.rules}>
              {rules.map((rule, index) => (
                <li key={index} className={styles.rule}>
                  <div className={styles.ruleText}>{rule.text}</div>
                  <div className={styles.ruleOrigin}>
                    {rule.versionId === undefined || rule.origin === undefined || rule.createdAt === undefined
                      ? "pas encore enregistrée"
                      : rule.origin === "user" && rule.versionId === firstVersionId
                        ? ruleOrigin(rule.origin, rule.originLabel, true, who(rule.person))
                        : metaLine(ruleOrigin(rule.origin, rule.originLabel, false, who(rule.person)), dayLabel(rule.createdAt))}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.grow} />

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
