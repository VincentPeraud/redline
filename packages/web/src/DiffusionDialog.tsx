import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type DesignSystemDetail, type DiffusionInfo, type DiffusionReview, type Page } from "@redline/shared";
import { routeHref } from "./router.js";
import { diffusionToastMessage } from "./diffusionLabels.js";
import { DiffusionReviewCards } from "./DiffusionReviewCards.js";
import { Select } from "./ui/index.js";
import { DIALOG_EXIT_MS } from "./ui/Dialog.js";
import styles from "./DiffusionDialog.module.css";

const TOAST_MS = 10_000;
const UNDO_POLL_MS = 3_000;

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
  const [toast, setToast] = useState<{ message: string; designSystemId: string; error?: string } | null>(null);
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
          {toast.error && <span className={styles.toastError}>{toast.error}</span>}
          <button
            type="button"
            className={styles.toastUndo}
            onClick={async () => {
              const res = await fetch(`/api/design-systems/${toast.designSystemId}/diffusions/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
              if (!res.ok) return setToast({ ...toast, error: res.status === 409 ? "Rien à annuler : cette diffusion l'a déjà été." : "L'annulation a échoué." });
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

interface DialogProps {
  designSystemId: string;
  onClose: () => void;
  onDiffused: (diffusion: DiffusionInfo, projects: number) => void;
  /** Opens the preview of the pending changes in the chosen project. Without it the control is shown disabled. */
  onOpenPreview?: (projectId: string) => void;
}

export function DiffusionDialog({ designSystemId, onClose, onDiffused, onOpenPreview }: DialogProps) {
  const [detail, setDetail] = useState<DesignSystemDetail | null>(null);
  const [review, setReview] = useState<DiffusionReview | null>(null);
  const [closing, setClosing] = useState(false);
  const [previewProject, setPreviewProject] = useState("");
  /** Pages of the project chosen for the preview; null while unknown. */
  const [previewPageCount, setPreviewPageCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [loaded, loadedReview] = await Promise.all([
      fetch(`/api/design-systems/${designSystemId}`).then((res) => res.json() as Promise<DesignSystemDetail>),
      fetch(`/api/design-systems/${designSystemId}/review`).then((res) => res.json() as Promise<DiffusionReview>),
    ]);
    setDetail(loaded);
    setReview(loadedReview);
    return loaded;
  }, [designSystemId]);

  useEffect(() => {
    void load().then((loaded) => setPreviewProject((loaded.overrides[0] ?? loaded.usedBy[0])?.id ?? ""));
  }, [load]);

  // A refused change stays "annulation en cours" until the design system's session publishes the undo: read the review again meanwhile.
  const undoing = review?.undoing ?? 0;
  useEffect(() => {
    if (undoing === 0) return;
    const timer = setInterval(() => void load(), UNDO_POLL_MS);
    return () => clearInterval(timer);
  }, [undoing, load]);

  useEffect(() => {
    if (previewProject === "") return;
    setPreviewPageCount(null);
    let cancelled = false;
    void fetch(`/api/projects/${previewProject}/pages`)
      .then((res) => res.json() as Promise<Page[]>)
      .then((pages) => {
        if (!cancelled) setPreviewPageCount(pages.length);
      });
    return () => {
      cancelled = true;
    };
  }, [previewProject]);

  /** Plays the exit animation, then runs `after` (unmounting the dialog). */
  const closeThen = useCallback((after: () => void) => {
    setClosing(true);
    setTimeout(after, DIALOG_EXIT_MS);
  }, []);
  const close = useCallback(() => closeThen(onClose), [closeThen, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!detail || !review) return null;
  const { pending, usedBy, current } = detail;
  const title = `Diffuser la version ${current.number + 1} de ${detail.title}`;

  async function diffuse() {
    setBusy(true);
    setFailed(false);
    const res = await fetch(`/api/design-systems/${designSystemId}/diffusions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (res.ok) {
      const diffusion = (await res.json()) as DiffusionInfo;
      return closeThen(() => onDiffused(diffusion, usedBy.length));
    }
    setBusy(false);
    setFailed(true);
  }

  return (
    <div className={styles.overlay} data-closing={closing || undefined} onClick={close}>
      <div role="dialog" aria-modal="true" aria-labelledby="diffusion-title" className={styles.panel} onClick={(event) => event.stopPropagation()}>
        <div className={styles.titleBlock}>
          <h2 id="diffusion-title" className={styles.title}>
            {title}
          </h2>
          <div className={styles.lead}>
            Relis ce qui a changé depuis la dernière diffusion : d'où vient chaque changement, avant / après, et les pages touchées. Les instances changent dans toutes les pages des projets dès que tu diffuses. Revenir ensuite à la diffusion précédente sera refusé si une page utilise ce qu'elle n'a pas.
          </div>
        </div>

        <DiffusionReviewCards review={review} detail={detail} onRefused={() => void load()} />
        <div className={styles.note}>
          Refuser un changement le défait dans le brouillon et prévient le projet qui l'a demandé. Les demandes diffusées se ferment, et leur fil se rouvre sur la maquette d'origine.
          {undoing > 0 && " Diffuser reste indisponible tant que l'annulation d'un changement refusé n'est pas faite dans le brouillon."}
        </div>

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
              <button type="button" className={styles.secondary} disabled={!onOpenPreview || previewPageCount === 0} onClick={() => onOpenPreview?.(previewProject)}>
                Ouvrir l'aperçu ↗
              </button>
              {previewPageCount === 0 && <span className={styles.muted}>Aucune page</span>}
            </>
          )}
          <div className={styles.grow} />
          <button type="button" className={styles.secondary} onClick={close}>
            Annuler
          </button>
          <button type="button" className={styles.primary} disabled={busy || pending.count === 0 || undoing > 0} onClick={() => void diffuse()}>
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
      Diffuser aux projets <span className={styles.headerCount}>{detail.reviewLines}</span>
    </button>
  );
}
