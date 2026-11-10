import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DesignSystemSummary, FitArtboardHeightRequest, MoveArtboardRequest, Page } from "@redline/shared";
import { moveRefusalMessage } from "./moveRefusal.js";
import { Button, Dialog, DialogActions, Field, TextInput, Tooltip, cx } from "./ui/index.js";
import { useCloseOnOutsidePointer } from "./useCloseOnOutsidePointer.js";
import styles from "./ArtboardMoreMenu.module.css";

function PlayLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M10 8.5l5 3.5-5 3.5z" />
    </svg>
  );
}

function MoveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h12" />
      <path d="M11 3l4 4-4 4" />
      <path d="M21 17H9" />
      <path d="M13 13l-4 4 4 4" />
    </svg>
  );
}

function FitHeightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v18" />
      <path d="M8 7l4-4 4 4" />
      <path d="M8 17l4 4 4-4" />
    </svg>
  );
}

/** The canvas is transformed, which would turn a modal's fixed overlay into a box inside it: dialogs go to the body. */
function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

function NewPageForMove({ file, onClose, onSubmit }: { file: string; onClose: () => void; onSubmit: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const canMove = title.trim() !== "";
  function submit(event: FormEvent) {
    event.preventDefault();
    if (canMove) void onSubmit(title.trim());
  }
  return (
    <Portal>
      <Dialog title="Nouvelle page" onClose={onClose} width={520}>
        <form onSubmit={submit} className={styles.form}>
          <Field label="Nom de la page" hint={`${file} y sera déplacé, avec ses commentaires.`}>
            <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Boutons" />
          </Field>
          <DialogActions>
            <Button size="lg" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" size="lg" disabled={!canMove}>
              Créer et déplacer
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Portal>
  );
}

interface Props {
  /** The page the artboard is on (the targets of "Déplacer vers" are the other pages of its project). */
  pageId: string;
  file: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopyPlayLink: () => void;
  /** Measured height of the artboard's page when it is taller than the artboard: offers "Ajuster la hauteur au contenu". */
  contentHeight?: number;
  /** Called once the fitted height is saved as a new version. */
  onFitted: () => void;
}

/** "⋯" button of an artboard's strip and its menu of the less frequent actions. */
export function ArtboardMoreMenu({ pageId, file, open, onOpenChange, onCopyPlayLink, contentHeight, onFitted }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const label = `Autres actions pour ${file}`;
  const [otherPages, setOtherPages] = useState<Page[] | null>(null);
  const [onDesignSystem, setOnDesignSystem] = useState(false);
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [refusal, setRefusal] = useState<{ title: string; message: string } | null>(null);

  useCloseOnOutsidePointer(root, open, () => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const { projectId } = (await (await fetch(`/api/pages/${pageId}`)).json()) as Page;
      const pages = (await (await fetch(`/api/projects/${projectId}/pages`)).json()) as Page[];
      setOtherPages(pages.filter((page) => page.id !== pageId));
      const systems = (await (await fetch("/api/design-systems")).json()) as DesignSystemSummary[];
      setOnDesignSystem(systems.some((system) => system.id === projectId));
    })();
  }, [open, pageId]);

  /** Moves the artboard at once; the pages and their threads refresh through the server events. A refusal is shown with its reason. */
  async function move(target: { targetPageId: string } | { newPageTitle: string }): Promise<void> {
    const request: MoveArtboardRequest = { file, ...target };
    const res = await fetch(`/api/pages/${pageId}/move-artboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    if (!res.ok) setRefusal({ title: "Déplacement impossible", message: moveRefusalMessage(((await res.json()) as { error: string }).error) });
  }

  /** Saves the measured page height as the artboard's height (a new version, like a move). */
  async function fitHeight(height: number): Promise<void> {
    const request: FitArtboardHeightRequest = { file, height };
    const res = await fetch(`/api/pages/${pageId}/fit-height`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    if (res.ok) onFitted();
    else setRefusal({ title: "Ajustement impossible", message: moveRefusalMessage(((await res.json()) as { error: string }).error, "L'ajustement de la hauteur a été refusé.") });
  }

  return (
    <div ref={root} className={styles.root}>
      <Tooltip label="Autres actions">
        <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} className={cx(styles.button, open && styles.buttonOpen)} onClick={() => onOpenChange(!open)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div role="menu" aria-label={label} className={styles.menu}>
          {contentHeight !== undefined && (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                onOpenChange(false);
                void fitHeight(contentHeight);
              }}
            >
              <FitHeightIcon />
              Ajuster la hauteur au contenu
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              onOpenChange(false);
              onCopyPlayLink();
            }}
          >
            <PlayLinkIcon />
            Copier le lien plein écran
          </button>
          {otherPages && (
            <>
              <div role="separator" className={styles.separator} />
              <div className={styles.groupLabel}>
                <MoveIcon />
                Déplacer vers
              </div>
              {otherPages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  role="menuitem"
                  className={cx(styles.item, styles.itemIndented)}
                  onClick={() => {
                    onOpenChange(false);
                    void move({ targetPageId: page.id });
                  }}
                >
                  {page.title}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className={cx(styles.item, styles.itemIndented)}
                onClick={() => {
                  onOpenChange(false);
                  setNewPageOpen(true);
                }}
              >
                + Nouvelle page…
              </button>
              <div className={styles.hint}>Ses commentaires le suivent.{onDesignSystem && " Les projets ne voient aucune différence."}</div>
            </>
          )}
        </div>
      )}
      {newPageOpen && (
        <NewPageForMove
          file={file}
          onClose={() => setNewPageOpen(false)}
          onSubmit={async (title) => {
            await move({ newPageTitle: title });
            setNewPageOpen(false);
          }}
        />
      )}
      {refusal && (
        <Portal>
          <Dialog title={refusal.title} onClose={() => setRefusal(null)} width={520}>
            <p className={styles.refusal}>{refusal.message}</p>
            <DialogActions>
              <Button size="lg" onClick={() => setRefusal(null)}>
                Fermer
              </Button>
            </DialogActions>
          </Dialog>
        </Portal>
      )}
    </div>
  );
}
