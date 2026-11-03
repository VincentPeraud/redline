import { useCallback, useEffect, useRef, useState } from "react";
import { instanceTagOf } from "@redline/shared";
import type { DesignMdVersion, DesignSystemSummary, DesignSystemSwitchPreview, ExcludedComponent, Project, ProjectComponentInfo, ProjectDesignSystem, ProjectStyleToken, PromoteProjectStyleRequest, SaveDesignMdRequest, SetProjectDesignSystemRequest } from "@redline/shared";
import type { MoveUpComponentRequest } from "@redline/shared";
import { dayLabel, designMdStatus, metaLine, originLabel } from "./historyLabels.js";
import { useWho } from "./useMe.js";
import { agree, counted } from "./plural.js";
import { pickerHex } from "./projectDesignSystemLabels.js";
import { relativeTime } from "./relativeTime.js";
import { routeHref } from "./router.js";
import { Button, DIALOG_EXIT_MS, Dialog, DialogActions, Field, Logo, Select, TextInput, Tooltip, cx } from "./ui/index.js";
import styles from "./ProjectDesignSystemScreen.module.css";
import { useDocumentTitle } from "./documentTitle.js";
import { SwitchDesignSystemDialog } from "./SwitchDesignSystemDialog.js";

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

const elided = (title: string) => (/^[aeiouyhàâéèêëîïôû]/i.test(title) ? `d'${title}` : `de ${title}`);

function ComponentCard({
  component,
  swatch,
  designSystemTitle,
  projectTitle,
  onMoveUp,
  onUseDesignSystem,
}: {
  component: ProjectComponentInfo;
  swatch: { background: string; shape: string };
  designSystemTitle: string | null;
  projectTitle: string;
  onMoveUp: (component: ProjectComponentInfo) => void;
  onUseDesignSystem: (name: string) => void;
}) {
  const tag = instanceTagOf(component.name);
  return (
    <div className={styles.component} data-testid={`component-${component.name}`}>
      <div className={styles.componentRow}>
        <div aria-hidden="true" className={styles.componentThumb} style={{ background: swatch.background }}>
          <div className={styles.componentShape} style={{ background: swatch.shape }} />
        </div>
        <div className={styles.componentText}>
          <a href={routeHref({ name: "page", pageId: component.page.id, artboard: component.file })} className={cx(styles.mono, styles.componentLink)}>
            {tag}
          </a>
          <span className={styles.componentPage}>{`${counted(component.instances, "instance", "instances")} · ${counted(component.pages, "page", "pages")}`}</span>
        </div>
        <span className={styles.ownPill}>propre au projet</span>
      </div>
      {component.inDesignSystem && (
        <div className={styles.collision}>
          <span className={styles.collisionPill}>existe aussi dans le design system</span>
          <span className={styles.sideText}>{`${designSystemTitle} diffuse son propre ${tag} depuis la diffusion ${component.diffusedSince}. ${projectTitle} garde le sien tant que tu ne changes pas.`}</span>
        </div>
      )}
      {component.inDesignSystem ? (
        <Button size="sm" className={styles.cardButton} onClick={() => onUseDesignSystem(component.name)}>
          Passer à celui du design system
        </Button>
      ) : component.movedUp ? (
        <span className={styles.sideText}>{`Remonté : il passera dans ${designSystemTitle} à la prochaine diffusion. ${projectTitle} garde le sien d'ici là.`}</span>
      ) : designSystemTitle !== null ? (
        <Button size="sm" className={styles.cardButton} onClick={() => onMoveUp(component)}>
          Remonter au design system
        </Button>
      ) : null}
    </div>
  );
}

function instancesSentence(instances: number, projectTitle: string, designSystemTitle: string): string {
  if (instances === 0) return `Aucune instance ${elided(projectTitle)} n'est concernée.`;
  if (instances === 1) return `L'instance ${elided(projectTitle)} ne change pas et suit désormais ${designSystemTitle}.`;
  return `Les ${instances} instances ${elided(projectTitle)} ne changent pas et suivent désormais ${designSystemTitle}.`;
}

function MoveUpDialog({
  component,
  designSystemTitle,
  projectTitle,
  pages,
  closing,
  onSubmit,
  onClose,
}: {
  component: ProjectComponentInfo;
  designSystemTitle: string;
  projectTitle: string;
  pages: { id: string; title: string }[];
  closing: boolean;
  onSubmit: (pageId: string) => void;
  onClose: () => void;
}) {
  const [pageId, setPageId] = useState(pages[0]?.id ?? "");
  const tag = instanceTagOf(component.name);
  return (
    <Dialog title={`Remonter ${tag}`} onClose={onClose} width={520} closing={closing}>
      <div className={styles.dialogText}>
        {`Le composant passe dans le brouillon de ${designSystemTitle}. ${instancesSentence(component.instances, projectTitle, designSystemTitle)} Les autres projets pourront l'utiliser après la prochaine diffusion.`}
      </div>
      <Field label="Page du design system">
        <Select size="lg" className={styles.moveUpSelect} value={pageId} onChange={(event) => setPageId(event.target.value)}>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.title}
            </option>
          ))}
        </Select>
      </Field>
      <DialogActions>
        <Button size="lg" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="accent" size="lg" disabled={pageId === ""} onClick={() => onSubmit(pageId)}>
          Remonter
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ExcludedCard({ component, onTake }: { component: ExcludedComponent; onTake: (name: string) => void }) {
  return (
    <div className={styles.component} data-testid={`excluded-${component.name}`}>
      <div className={styles.componentText}>
        <span className={styles.mono}>{component.tag}</span>
        <span className={styles.componentPage}>{component.available ? `non repris de ${component.from}` : `absent de ${component.from}`}</span>
      </div>
      {component.available && (
        <Button size="sm" className={styles.takeButton} onClick={() => onTake(component.name)}>
          Prendre celui de {component.from}
        </Button>
      )}
    </div>
  );
}

function HistoryDialog({ versions, onRestore, onClose }: { versions: DesignMdVersion[]; onRestore: (version: DesignMdVersion) => void; onClose: () => void }) {
  const who = useWho();
  return (
    <Dialog title="Historique du style du projet" onClose={onClose} width={520}>
      <ol className={styles.versions}>
        {versions.map((version, index) => (
          <li key={version.id} className={styles.version}>
            <span className={styles.versionText}>
              <span>{relativeTime(version.createdAt)}</span>
              <span className={styles.versionMeta}>{originLabel(version.origin, version.originLabel, who(version.person))}</span>
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
  const who = useWho();
  const [project, setProject] = useState<Project | null>(null);
  const [detail, setDetail] = useState<ProjectDesignSystem | null>(null);
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [versions, setVersions] = useState<DesignMdVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [switching, setSwitching] = useState<DesignSystemSwitchPreview | null>(null);
  const [movingUp, setMovingUp] = useState<{ component: ProjectComponentInfo; closing: boolean } | null>(null);
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

  async function changeDesignSystem(id: string) {
    if (detail?.designSystem && id !== "none" && id !== detail.designSystem.id) {
      const res = await fetch(`/api/projects/${projectId}/design-system/switch?to=${encodeURIComponent(id)}`);
      if (!res.ok) return setError(((await res.json()) as { error: string }).error);
      const preview = (await res.json()) as DesignSystemSwitchPreview;
      if (preview.components.length > 0) return setSwitching(preview);
    }
    await applyDesignSystem(id);
  }

  async function applyDesignSystem(id: string, ticked?: string[]) {
    const body: SetProjectDesignSystemRequest = { designSystem: id === "none" ? null : id, ...(ticked && { ticked }) };
    await change(fetch(`/api/projects/${projectId}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  const takeComponent = (name: string) => change(fetch(`/api/projects/${projectId}/design-system/components/${encodeURIComponent(name)}/take`, { method: "POST" }));

  const componentUrl = (name: string, action: string) => `/api/projects/${projectId}/design-system/components/${encodeURIComponent(name)}/${action}`;
  const useDesignSystemComponent = (name: string) => change(fetch(componentUrl(name, "use-design-system"), { method: "POST" }));

  function closeMoveUp() {
    setMovingUp((current) => current && { ...current, closing: true });
    window.setTimeout(() => setMovingUp(null), DIALOG_EXIT_MS);
  }

  async function moveUp(name: string, pageId: string) {
    closeMoveUp();
    const body: MoveUpComponentRequest = { pageId };
    await change(fetch(componentUrl(name, "move-up"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
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

  useDocumentTitle("Design system", project?.title);

  if (!project || !detail) return <main className={styles.screen}>Chargement…</main>;

  const shared = detail.designSystem;
  const title = shared?.title ?? null;
  const latest = detail.lastModified;
  const colour = (name: string, fallback: string) => detail.tokens.find((t) => t.name === name && t.isColor)?.value ?? fallback;
  const thumb = { background: colour("--color-background", "transparent"), shape: colour("--color-primary", "transparent") };
  const selectedId = switching?.to.id ?? shared?.id ?? "none";
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
            {designMdStatus(latest.origin, latest.originLabel, dayLabel(latest.createdAt), who(latest.person))}
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
              <select id="ds-select" className={styles.select} value={selectedId} onChange={(event) => void changeDesignSystem(event.target.value)}>
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
                <a href={routeHref({ name: "designSystem", designSystemId: shared.id, viaProjectId: projectId })}>ouvrir {shared.title}</a>
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
              {shared ? `Créés par les sessions du projet quand ${shared.title} n'avait rien d'approchant. ` : "Créés par les sessions du projet. "}
              Ils s'utilisent en instance dans toutes les pages du projet.
              {shared && " Les remonter les rend disponibles pour tous les projets."}
            </div>
            {detail.components.map((component) => (
              <ComponentCard
                key={component.file}
                component={component}
                swatch={thumb}
                designSystemTitle={title}
                projectTitle={project.title}
                onMoveUp={(target) => setMovingUp({ component: target, closing: false })}
                onUseDesignSystem={(name) => void useDesignSystemComponent(name)}
              />
            ))}
          </section>

          {detail.excluded.length > 0 && (
            <section className={styles.sideSection} data-testid="excluded-components">
              <h2 className={styles.sideTitle}>Composants non repris · {detail.excluded.length}</h2>
              <div className={styles.sideText}>Laissés de côté au changement de design system : leurs instances s'affichent en erreur dans les pages, jusqu'à ce que tu les prennes ici ou que les pages soient converties.</div>
              {detail.excluded.map((component) => (
                <ExcludedCard key={component.name} component={component} onTake={(name) => void takeComponent(name)} />
              ))}
            </section>
          )}

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

      {switching && (
        <SwitchDesignSystemDialog
          projectTitle={project.title}
          fromTitle={shared!.title}
          preview={switching}
          onClose={() => setSwitching(null)}
          onConfirm={async (ticked) => {
            setSwitching(null);
            await applyDesignSystem(switching.to.id, ticked);
          }}
        />
      )}
      {movingUp && shared && (
        <MoveUpDialog
          component={movingUp.component}
          designSystemTitle={shared.title}
          projectTitle={project.title}
          pages={detail.designSystemPages}
          closing={movingUp.closing}
          onSubmit={(pageId) => void moveUp(movingUp.component.name, pageId)}
          onClose={closeMoveUp}
        />
      )}
      {promoteOpen && <PromoteDialog initialTitle={project.title} onSubmit={promote} onClose={() => setPromoteOpen(false)} />}
      {historyOpen && <HistoryDialog versions={versions} onRestore={restore} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
