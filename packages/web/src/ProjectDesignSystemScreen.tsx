import { useCallback, useEffect, useRef, useState } from "react";
import type { DesignMdVersion, DesignSystemSummary, Project, ProjectComponentInfo, ProjectDesignSystem, ProjectStyleToken, PromoteProjectStyleRequest, SaveDesignMdRequest, SetProjectDesignSystemRequest } from "@redline/shared";
import { dayLabel, designMdAuthor, originLabel } from "./historyLabels.js";
import { agree } from "./plural.js";
import { pickerHex } from "./projectDesignSystemLabels.js";
import { relativeTime } from "./relativeTime.js";
import { routeHref } from "./router.js";
import { Button, Dialog, DialogActions, Field, Logo, TextInput, Tooltip, cx } from "./ui/index.js";
import styles from "./ProjectDesignSystemScreen.module.css";

const CHEVRON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.chevron}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/** Native colour input committing on the browser's `change` (picker closed), not on every drag step. */
function ColorField({ value, label, onCommit }: { value: string; label: string; onCommit: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current!;
    const commit = () => onCommit(element.value);
    element.addEventListener("change", commit);
    return () => element.removeEventListener("change", commit);
  }, [onCommit]);
  return <input ref={input} key={value} type="color" defaultValue={value} aria-label={label} className={styles.picker} />;
}

function TextField({ value, label, onCommit }: { value: string; label: string; onCommit: (value: string) => void }) {
  return (
    <input
      key={value}
      defaultValue={value}
      aria-label={label}
      spellCheck={false}
      className={styles.valueInput}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if (next === "" || next === value) event.currentTarget.value = value;
        else onCommit(next);
      }}
    />
  );
}

function Swatch({ value }: { value: string }) {
  return <span aria-hidden="true" className={styles.swatch} style={{ background: value }} />;
}

function TokenRow({
  token,
  designSystemTitle,
  onSet,
  onReset,
}: {
  token: ProjectStyleToken;
  designSystemTitle: string | null;
  onSet: (name: string, value: string) => void;
  onReset: (name: string) => void;
}) {
  const overridden = token.status === "overridden";
  const inherited = token.status === "inherited";
  const hex = pickerHex(token.value);
  const commit = useCallback((value: string) => onSet(token.name, value), [onSet, token.name]);
  return (
    <div data-testid={`token-${token.name}`} className={cx(styles.row, overridden && styles.rowOverridden)}>
      <span className={styles.nameCell}>
        <span className={styles.mono}>{token.name}</span>
        {token.deprecatedFor && (
          <Tooltip label={`Renommé en ${token.deprecatedFor}`}>
            <span tabIndex={0} className={styles.deprecated}>
              déprécié
            </span>
          </Tooltip>
        )}
        {token.core && (
          <span title="Token de base" className={styles.base}>
            base
          </span>
        )}
      </span>
      {designSystemTitle !== null && (
        <span className={cx(styles.designSystemCell, overridden && styles.designSystemOverridden)}>
          {token.designSystemValue !== null && token.isColor && <Swatch value={token.designSystemValue} />}
          <span className={styles.mono}>{token.designSystemValue ?? "—"}</span>
        </span>
      )}
      <span className={styles.projectCell}>
        {inherited ? (
          <>
            <span className={styles.inherits}>Valeur de {designSystemTitle}</span>
            <button type="button" className={styles.override} onClick={() => onSet(token.name, token.value)}>
              Surcharger
            </button>
          </>
        ) : (
          <>
            {hex && <ColorField value={hex} label={`Couleur de ${token.name}`} onCommit={commit} />}
            <TextField value={token.value} label={`Valeur de ${token.name}`} onCommit={commit} />
            {overridden && (
              <>
                <span className={styles.overriddenPill}>surchargée</span>
                <Tooltip label={`Revenir à la valeur de ${designSystemTitle}`}>
                  <button type="button" aria-label={`Revenir à la valeur de ${designSystemTitle} pour ${token.name}`} className={styles.reset} onClick={() => onReset(token.name)}>
                    ↺
                  </button>
                </Tooltip>
              </>
            )}
            {token.status === "new" && <span className={styles.newPill}>nouveau</span>}
          </>
        )}
      </span>
    </div>
  );
}

function ComponentCard({ component, swatch }: { component: ProjectComponentInfo; swatch: { background: string; shape: string } }) {
  const overrides = component.status === "override";
  return (
    <a href={routeHref({ name: "page", pageId: component.page.id, artboard: component.file })} className={styles.component}>
      <div aria-hidden="true" className={styles.componentThumb} style={{ background: swatch.background }}>
        <div className={styles.componentShape} style={{ background: swatch.shape }} />
      </div>
      <div className={styles.componentText}>
        <span className={styles.mono}>{component.name}</span>
        <span className={styles.componentPage}>page {component.page.title}</span>
      </div>
      <span className={overrides ? styles.overriddenPill : styles.newPill}>{overrides ? "surchargé" : "nouveau"}</span>
    </a>
  );
}

function HistoryDialog({ versions, onRestore, onClose }: { versions: DesignMdVersion[]; onRestore: (version: DesignMdVersion) => void; onClose: () => void }) {
  return (
    <Dialog title="Historique du style du projet" onClose={onClose} width={520}>
      <ol className={styles.versions}>
        {versions.map((version, index) => (
          <li key={version.id} className={styles.version}>
            <span className={styles.versionText}>
              <span>{relativeTime(version.createdAt)}</span>
              <span className={styles.versionMeta}>{originLabel(version.origin, version.originLabel)}</span>
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

function PromoteDialog({ initialTitle, onSubmit, onClose }: { initialTitle: string; onSubmit: (title: string) => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const canCreate = title.trim() !== "" && !busy;
  return (
    <Dialog title="En faire un design system" onClose={onClose} width={520}>
      <form
        className={styles.promoteForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreate) return;
          setBusy(true);
          void onSubmit(title.trim());
        }}
      >
        <Field label="Nom du design system" hint="Les variables et les composants du projet deviennent la diffusion 1. Le projet le suit ensuite, sans surcharge.">
          <TextInput autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <DialogActions>
          <Button size="lg" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" variant="accent" size="lg" disabled={!canCreate}>
            Créer le design system
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function ProjectDesignSystemScreen({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [detail, setDetail] = useState<ProjectDesignSystem | null>(null);
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [versions, setVersions] = useState<DesignMdVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(
    () =>
      fetch(`/api/projects/${projectId}/project-style/versions`)
        .then((res) => res.json() as Promise<DesignMdVersion[]>)
        .then(setVersions),
    [projectId],
  );

  const loadDesignSystems = useCallback(
    () =>
      fetch("/api/design-systems")
        .then((res) => res.json() as Promise<DesignSystemSummary[]>)
        .then(setDesignSystems),
    [],
  );

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json() as Promise<Project>)
      .then(setProject);
    fetch(`/api/projects/${projectId}/design-system`)
      .then((res) => res.json() as Promise<ProjectDesignSystem>)
      .then(setDetail);
    void loadDesignSystems();
    void loadVersions();
  }, [projectId, loadVersions, loadDesignSystems]);

  const change = useCallback(
    async (request: Promise<Response>) => {
      const res = await request;
      if (res.ok) {
        setError(null);
        setDetail((await res.json()) as ProjectDesignSystem);
        await loadVersions();
      } else {
        setError(((await res.json()) as { error: string }).error);
        setDetail((current) => (current ? { ...current } : current));
      }
    },
    [loadVersions],
  );
  const tokenUrl = (name: string) => `/api/projects/${projectId}/project-style/tokens/${encodeURIComponent(name)}`;
  const setToken = useCallback(
    (name: string, value: string) =>
      change(fetch(tokenUrl(name), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [change, projectId],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resetToken = useCallback((name: string) => change(fetch(tokenUrl(name), { method: "DELETE" })), [change, projectId]);

  function changeDesignSystem(id: string) {
    const body: SetProjectDesignSystemRequest = { designSystem: id === "none" ? null : id };
    void change(fetch(`/api/projects/${projectId}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async function promote(title: string) {
    const body: PromoteProjectStyleRequest = { title };
    const res = await fetch(`/api/projects/${projectId}/design-system/promote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setPromoteOpen(false);
    if (!res.ok) return setError(((await res.json()) as { error: string }).error);
    setError(null);
    setDetail((await (await fetch(`/api/projects/${projectId}/design-system`)).json()) as ProjectDesignSystem);
    await Promise.all([loadVersions(), loadDesignSystems()]);
  }

  async function restore(version: DesignMdVersion) {
    const body: SaveDesignMdRequest = { content: version.content };
    await fetch(`/api/projects/${projectId}/project-style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setDetail((await (await fetch(`/api/projects/${projectId}/design-system`)).json()) as ProjectDesignSystem);
    await loadVersions();
    setHistoryOpen(false);
  }

  if (!project || !detail) return <main className={styles.screen}>Chargement…</main>;

  const shared = detail.designSystem;
  const title = shared?.title ?? null;
  const latest = detail.lastModified;
  const colour = (name: string, fallback: string) => detail.tokens.find((t) => t.name === name && t.isColor)?.value ?? fallback;
  const thumb = { background: colour("--color-background", "transparent"), shape: colour("--color-primary", "transparent") };
  const selectedId = shared?.id ?? "none";
  const overridden = detail.overrideCount;
  const fresh = !shared && !detail.styleDefinesTokens;

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
          <span className={styles.current}>Design system</span>
        </nav>
        <div className={styles.grow} />
        {latest && (
          <div data-testid="project-style-status" className={styles.status}>
            Dernière modification par {designMdAuthor(latest.origin, latest.originLabel)} · {dayLabel(latest.createdAt)}
          </div>
        )}
        <button type="button" className={styles.historyLink} onClick={() => setHistoryOpen(true)}>
          Historique
        </button>
        <a href={routeHref({ name: "project", projectId })} className={styles.closeLink}>
          Fermer
        </a>
      </header>

      <div className={styles.body}>
        <main className={styles.main}>
          <section className={styles.chooser}>
            <label htmlFor="ds-select" className={styles.chooserLabel}>
              Design system
            </label>
            <span className={styles.selectWrap}>
              <select id="ds-select" className={styles.select} value={selectedId} onChange={(event) => changeDesignSystem(event.target.value)}>
                {designSystems.map((system) => (
                  <option key={system.id} value={system.id}>
                    {system.title}
                  </option>
                ))}
                <option value="none">Aucun : style propre au projet</option>
              </select>
              {CHEVRON}
            </span>
            {shared && detail.diffusion ? (
              <span className={styles.chooserNote}>
                Diffusion {detail.diffusion.number} du {new Date(detail.diffusion.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ·{" "}
                <a href={routeHref({ name: "designSystems" })}>ouvrir {shared.title}</a>
              </span>
            ) : (
              <>
                <span className={styles.chooserNote}>Ce style n'est pas partagé et n'apparaît pas dans la liste des design systems.</span>
                <div className={styles.grow} />
                {detail.styleDefinesTokens ? (
                  <button type="button" className={styles.promote} onClick={() => setPromoteOpen(true)}>
                    En faire un design system…
                  </button>
                ) : (
                  <Tooltip label="Le style du projet est encore vide">
                    <button type="button" className={styles.promote} aria-disabled="true">
                      En faire un design system…
                    </button>
                  </Tooltip>
                )}
              </>
            )}
          </section>

          <section className={styles.variables}>
            <div className={styles.variablesHeading}>
              <h2 className={styles.variablesTitle}>Variables</h2>
              <span className={styles.variablesHint}>
                {shared
                  ? `${overridden} ${agree(overridden, "surchargée", "surchargées")} · les autres suivent ${shared.title}`
                  : fresh
                    ? "Aucune pour l'instant"
                    : "Le style du projet : modifiables ici ou en le demandant à Claude"}
              </span>
            </div>
            {error && (
              <div role="alert" className={styles.error}>
                {error}
              </div>
            )}
            {fresh ? (
              <div data-testid="fresh-style" className={styles.fresh}>
                <h3 className={styles.freshTitle}>Pas encore de style</h3>
                <p className={styles.freshText}>
                  Claude le crée d'après le sujet du projet à ta première demande : polices, fond, couleurs d'accent. Tu pourras ensuite le modifier ici ou en le lui demandant.
                </p>
              </div>
            ) : (
              <div className={styles.table}>
                <div className={styles.headRow}>
                  <span className={styles.nameCol}>Variable</span>
                  {title !== null && <span className={styles.designSystemCol}>{title}</span>}
                  <span className={styles.grow}>{shared ? "Ce projet" : "Valeur"}</span>
                </div>
                {detail.tokens.map((token) => (
                  <TokenRow key={token.name} token={token} designSystemTitle={title} onSet={setToken} onReset={resetToken} />
                ))}
              </div>
            )}
          </section>
        </main>

        <aside aria-label="Composants et règles" className={styles.side}>
          <section className={styles.sideSection}>
            <h2 className={styles.sideTitle}>Composants du projet · {detail.components.length}</h2>
            <div className={styles.sideText}>
              Fichiers <span className={styles.inlineMono}>components/</span> des pages du projet. Ils servent dans toutes les pages du projet.
            </div>
            {detail.components.map((component) => (
              <ComponentCard key={component.file} component={component} swatch={thumb} />
            ))}
          </section>

          <section className={styles.designMd}>
            <div className={styles.designMdHeading}>
              <h2 className={styles.designMdTitle}>DESIGN.md</h2>
              <div className={styles.grow} />
              <a href={routeHref({ name: "designMd", projectId })}>Modifier</a>
            </div>
            <div className={styles.sideText}>{shared ? `Règles du projet. Elles l'emportent sur celles de ${shared.title}.` : "Règles du projet."}</div>
          </section>
        </aside>
      </div>

      {promoteOpen && <PromoteDialog initialTitle={project.title} onSubmit={promote} onClose={() => setPromoteOpen(false)} />}
      {historyOpen && <HistoryDialog versions={versions} onRestore={restore} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
