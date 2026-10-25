import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { componentPreviewUrlPath, isColorValue, type DesignSystemDetail, type DiffusionInfo, type Page } from "@redline/shared";
import { routeHref } from "./router.js";
import { diffusionToastMessage } from "./diffusionLabels.js";
import { agree } from "./plural.js";
import { Select, cx } from "./ui/index.js";
import styles from "./DiffusionDialog.module.css";

const TOAST_MS = 10_000;

interface DiffusionControls {
  /** Opens the "Diffuser la version N de <design system>" dialog. */
  open: (designSystemId: string) => void;
  /** Bumped after every diffusion, so views of a design system reload what is pending. */
  version: number;
}

const DiffusionContext = createContext<DiffusionControls | null>(null);

/** Entry point of the diffusion dialog: `useOpenDiffusionDialog()(designSystemId)` from the header button, the card under Claude's answer or the design system overview. */
export function useOpenDiffusionDialog(): (designSystemId: string) => void {
  return useContext(DiffusionContext)!.open;
}

/**
 * The design system `id` with its current diffusion and what is pending; null while loading or when `id` is not a design system.
 * Reloads after a diffusion and whenever `refreshKey` changes (no server-event subscription of its own: the browser keeps few event streams open per origin).
 */
export function useDesignSystemDetail(id: string | undefined, refreshKey?: string): DesignSystemDetail | null {
  const { version } = useContext(DiffusionContext)!;
  const [detail, setDetail] = useState<DesignSystemDetail | null>(null);

  useEffect(() => {
    if (!id) return setDetail(null);
    let cancelled = false;
    const load = async () => {
      const res = await fetch(`/api/design-systems/${id}`);
      const next = res.ok ? ((await res.json()) as DesignSystemDetail) : null;
      if (!cancelled) setDetail(next);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, version, refreshKey]);

  return detail;
}

/** Opens, in a new tab, the first page of `projectId` shown with the draft of the design system (read-only, for this viewer only). */
async function openPreview(designSystemId: string, projectId: string) {
  const pages = (await (await fetch(`/api/projects/${projectId}/pages`)).json()) as Page[];
  const first = pages[0];
  if (first) window.open(`${window.location.pathname}${routeHref({ name: "page", pageId: first.id, previewOf: designSystemId })}`, "_blank");
}

export function DiffusionProvider({ children }: { children: ReactNode }) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; designSystemId: string } | null>(null);
  const [version, setVersion] = useState(0);
  const open = useCallback((designSystemId: string) => setOpenFor(designSystemId), []);
  const controls = useMemo(() => ({ open, version }), [open, version]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <DiffusionContext.Provider value={controls}>
      {children}
      {openFor && (
        <DiffusionDialog
          designSystemId={openFor}
          onClose={() => setOpenFor(null)}
          onOpenPreview={(projectId) => void openPreview(openFor, projectId)}
          onDiffused={(diffusion, projects) => {
            setOpenFor(null);
            setToast({ message: diffusionToastMessage(diffusion.number, projects), designSystemId: openFor });
            setVersion((v) => v + 1);
          }}
        />
      )}
      {toast && (
        <div role="status" data-testid="diffusion-toast" className={styles.toast}>
          {toast.message}
          <button
            type="button"
            className={styles.toastUndo}
            onClick={async () => {
              await fetch(`/api/design-systems/${toast.designSystemId}/diffusions/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
              setToast(null);
              setVersion((v) => v + 1);
            }}
          >
            Annuler
          </button>
        </div>
      )}
    </DiffusionContext.Provider>
  );
}

function Swatch({ value }: { value: string }) {
  return isColorValue(value) ? <span aria-hidden="true" className={styles.swatch} style={{ background: value }} /> : null;
}

function TokenValue({ value, muted }: { value: string; muted?: boolean }) {
  return (
    <>
      <Swatch value={value} />
      <span className={cx(styles.mono, muted && styles.muted)}>{value}</span>
    </>
  );
}

function Preview({ label, src }: { label: string; src: string }) {
  return (
    <div role="img" aria-label={label} className={styles.preview}>
      <iframe title={label} src={src} sandbox="allow-scripts" tabIndex={-1} aria-hidden="true" className={styles.previewFrame} />
    </div>
  );
}

function ComponentCard({ name, kind, designSystemId, artboardOrigin, before }: { name: string; kind: "changed" | "added" | "removed"; designSystemId: string; artboardOrigin: string; before: number }) {
  const tag = { changed: "modifié", added: "nouveau", removed: "supprimé" }[kind];
  return (
    <div className={styles.componentCard} data-testid="diffusion-component">
      <div className={styles.componentHead}>
        <span className={styles.mono}>{name}</span>
        <span className={cx(styles.tag, styles[`tag-${kind}`])}>{tag}</span>
      </div>
      {kind === "changed" && (
        <div className={styles.beforeAfter}>
          <Preview label="Avant" src={artboardOrigin + componentPreviewUrlPath(designSystemId, name, before)} />
          <span aria-hidden="true" className={styles.muted}>→</span>
          <Preview label="Après" src={artboardOrigin + componentPreviewUrlPath(designSystemId, name)} />
        </div>
      )}
      {kind === "added" && <Preview label="Après" src={artboardOrigin + componentPreviewUrlPath(designSystemId, name)} />}
    </div>
  );
}

interface DialogProps {
  designSystemId: string;
  onClose: () => void;
  onDiffused: (diffusion: DiffusionInfo, projects: number) => void;
  /** Opens the preview of the pending changes in the chosen project. Without it the control is shown disabled. */
  onOpenPreview?: (projectId: string) => void;
}

export function DiffusionDialog({ designSystemId, onClose, onDiffused, onOpenPreview }: DialogProps) {
  const [detail, setDetail] = useState<DesignSystemDetail | null>(null);
  const [artboardOrigin, setArtboardOrigin] = useState("");
  const [previewProject, setPreviewProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      const [loaded, config] = await Promise.all([
        fetch(`/api/design-systems/${designSystemId}`).then((res) => res.json() as Promise<DesignSystemDetail>),
        fetch("/api/config").then((res) => res.json() as Promise<{ artboardOrigin: string }>),
      ]);
      setDetail(loaded);
      setArtboardOrigin(config.artboardOrigin);
      setPreviewProject((loaded.overrides[0] ?? loaded.usedBy[0])?.id ?? "");
    })();
  }, [designSystemId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!detail) return null;
  const { pending, usedBy, overrides, current } = detail;
  const title = `Diffuser la version ${current.number + 1} de ${detail.title}`;
  const removedTokens = pending.tokens.removed;
  const { added, changed, removed } = pending.components;

  async function diffuse() {
    setBusy(true);
    setFailed(false);
    const res = await fetch(`/api/design-systems/${designSystemId}/diffusions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (res.ok) return onDiffused((await res.json()) as DiffusionInfo, usedBy.length);
    setBusy(false);
    setFailed(true);
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="diffusion-title" className={styles.panel} onClick={(event) => event.stopPropagation()}>
        <div className={styles.titleBlock}>
          <h2 id="diffusion-title" className={styles.title}>
            {title}
          </h2>
          <div className={styles.lead}>Les projets reçoivent ces changements dès que tu diffuses. Tu peux revenir à la diffusion précédente à tout moment.</div>
        </div>

        {pending.tokens.changed.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Tokens modifiés</h3>
            {pending.tokens.changed.map((token) => (
              <div key={token.name} className={styles.tokenRow} data-testid="diffusion-token">
                <span className={cx(styles.mono, styles.tokenName)}>{token.name}</span>
                <TokenValue value={token.from} muted />
                <span aria-hidden="true" className={styles.muted}>→</span>
                <TokenValue value={token.to} />
              </div>
            ))}
          </section>
        )}
        {pending.tokens.added.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Tokens ajoutés</h3>
            {pending.tokens.added.map((token) => (
              <div key={token.name} className={styles.tokenRow} data-testid="diffusion-token">
                <span className={cx(styles.mono, styles.tokenName)}>{token.name}</span>
                <TokenValue value={token.value} />
              </div>
            ))}
          </section>
        )}
        {removedTokens.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Tokens supprimés</h3>
            {removedTokens.map((token) => (
              <div key={token.name} className={styles.tokenRow} data-testid="diffusion-token">
                <span className={cx(styles.mono, styles.tokenName)}>{token.name}</span>
                <TokenValue value={token.value} muted />
              </div>
            ))}
          </section>
        )}

        {changed.length + added.length + removed.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Composants</h3>
            <div className={styles.componentGrid}>
              {changed.map((name) => <ComponentCard key={`c-${name}`} name={name} kind="changed" designSystemId={designSystemId} artboardOrigin={artboardOrigin} before={current.number} />)}
              {added.map((name) => <ComponentCard key={`a-${name}`} name={name} kind="added" designSystemId={designSystemId} artboardOrigin={artboardOrigin} before={current.number} />)}
              {removed.map((name) => <ComponentCard key={`r-${name}`} name={name} kind="removed" designSystemId={designSystemId} artboardOrigin={artboardOrigin} before={current.number} />)}
            </div>
          </section>
        )}

        {pending.designMdChanged && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>DESIGN.md</h3>
            <div className={styles.line}>DESIGN.md modifié</div>
          </section>
        )}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Projets concernés · {usedBy.length}</h3>
          <div className={styles.projects}>
            {usedBy.length === 0 && <div className={styles.muted}>Aucun projet n'utilise encore ce design system.</div>}
            {usedBy.length > overrides.length && <div>{usedBy.filter((project) => !overrides.some((o) => o.id === project.id)).map((project) => project.title).join(" · ")}</div>}
            {overrides.map((project) => (
              <div key={project.id} className={styles.warning} data-testid="diffusion-override">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.warningIcon}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 16h.01" />
                </svg>
                <span>
                  <b>{project.title}</b> surcharge{" "}
                  {project.tokens.map((token, index) => (
                    <span key={token}>
                      {index > 0 && ", "}
                      <span className={styles.mono}>{token}</span>
                    </span>
                  ))}{" "}
                  : {agree(project.tokens.length, "ce changement y sera sans effet.", "ces changements y seront sans effet.")}
                </span>
              </div>
            ))}
          </div>
        </section>

        {failed && <div role="alert" className={styles.error}>Rien à diffuser : la version a déjà changé.</div>}

        <div className={styles.actions}>
          {usedBy.length > 0 && (
            <>
              <label htmlFor="diffusion-preview-project" className={styles.previewLabel}>Aperçu dans</label>
              <span className={styles.previewSelect}>
                <Select id="diffusion-preview-project" value={previewProject} onChange={(event) => setPreviewProject(event.target.value)}>
                  {usedBy.map((project) => (
                    <option key={project.id} value={project.id}>{project.title}</option>
                  ))}
                </Select>
              </span>
              <button type="button" className={styles.secondary} disabled={!onOpenPreview} onClick={() => onOpenPreview?.(previewProject)}>
                Ouvrir l'aperçu ↗
              </button>
            </>
          )}
          <div className={styles.grow} />
          <button type="button" className={styles.secondary} onClick={onClose}>
            Annuler
          </button>
          <button type="button" className={styles.primary} disabled={busy || pending.count === 0} onClick={() => void diffuse()}>
            Diffuser
          </button>
        </div>
      </div>
    </div>
  );
}

/** The red "Diffuser aux projets · N" button of a design system page's header (nothing while no change is pending). */
export function DiffuseButton({ designSystemId, refreshKey }: { designSystemId: string | undefined; /** Changes when the page got a new version. */ refreshKey: string }) {
  const detail = useDesignSystemDetail(designSystemId, refreshKey);
  const open = useOpenDiffusionDialog();
  if (!detail || detail.pending.count === 0) return null;
  return (
    <button type="button" className={styles.headerButton} onClick={() => open(detail.id)}>
      Diffuser aux projets <span className={styles.headerCount}>{detail.pending.count}</span>
    </button>
  );
}
