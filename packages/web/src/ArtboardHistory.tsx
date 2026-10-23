import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { artboardVersionsPath, type ArtboardVersion } from "@redline/shared";
import { historyDate, originLabel } from "./historyLabels.js";
import { cx } from "./ui/index.js";
import styles from "./ArtboardHistory.module.css";

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

interface Props {
  pageId: string;
  /** Artboard file, e.g. `ecran-1.html`. */
  file: string;
  /** Bumped when the page changed, to refetch the versions. */
  pageVersionId: string;
  /** Version the artboard shows in place, read-only; null = the live artboard. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  previewVersionId: string | null;
  onPreview: (versionId: string | null) => void;
  onRestore: (versionId: string) => Promise<void>;
  className?: string;
}

const POPOVER_WIDTH = 310;
const POPOVER_GAP = 12;

/** Clock button of an artboard's label row and its popover "Historique · <artboard>": versions, preview in place, restore. */
export function ArtboardHistory({ pageId, file, pageVersionId, open, onOpenChange, previewVersionId, onPreview, onRestore, className }: Props) {

  const [versions, setVersions] = useState<ArtboardVersion[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // The popover sits beside the artboard so its preview stays visible: on the right, or on the left when only that side has room.
  const [onLeft, setOnLeft] = useState(false);
  const name = file.replace(/\.html$/, "");

  function close() {
    onOpenChange(false);
    onPreview(null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch(artboardVersionsPath(pageId, file))
      .then((res) => res.json() as Promise<ArtboardVersion[]>)
      .then((list) => {
        if (!cancelled) setVersions(list);
      });
    return () => {
      cancelled = true;
    };
  }, [open, pageId, file, pageVersionId]);

  useLayoutEffect(() => {
    if (!open) return;
    const label = root.current?.parentElement;
    const viewport = root.current?.closest("[data-canvas-viewport]");
    if (!label || !viewport) return;
    const artboard = label.getBoundingClientRect();
    const canvas = viewport.getBoundingClientRect();
    const roomRight = canvas.right - artboard.right;
    const roomLeft = artboard.left - canvas.left;
    setOnLeft(roomRight < POPOVER_GAP + POPOVER_WIDTH && roomLeft > roomRight);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  });

  async function restore(versionId: string) {
    setRestoring(true);
    try {
      await onRestore(versionId);
      onOpenChange(false);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div ref={root} className={cx(styles.root, className)}>
      <button
        type="button"
        aria-label={`Historique de ${file}`}
        title="Historique"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cx(styles.button, open && styles.buttonOpen)}
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        <ClockIcon />
      </button>
      {open && (
        <div role="dialog" aria-label={`Historique de ${file}`} className={cx(styles.popover, onLeft && styles.popoverLeft)}>
          <div className={styles.head}>
            <span className={styles.title}>Historique · {name}</span>
            <span className={styles.spacer} />
            <button type="button" aria-label="Fermer l'historique" className={styles.close} onClick={close}>
              ×
            </button>
          </div>
          {(versions ?? []).map((version) => {
            const previewing = version.versionId === previewVersionId;
            const meta = `${originLabel(version.origin, version.originLabel)} · ${historyDate(version.createdAt, { withTime: true })}`;
            if (previewing) {
              return (
                <div key={version.versionId} data-testid="history-preview" className={styles.previewRow}>
                  <div className={styles.rowLine}>
                    <div className={styles.rowText}>
                      <div className={styles.rowTitle}>{version.title}</div>
                      <div className={styles.rowMeta}>{meta}</div>
                    </div>
                    <span className={styles.previewTag}>en aperçu</span>
                  </div>
                  <div className={styles.previewNote}>L'artboard affiche cette version. Rien ne change tant que tu ne restaures pas.</div>
                  <div className={styles.previewActions}>
                    <button type="button" className={styles.restore} disabled={restoring} onClick={() => void restore(version.versionId)}>
                      Restaurer cette version
                    </button>
                    <button type="button" className={styles.cancel} onClick={() => onPreview(null)}>
                      Annuler
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <button
                key={version.versionId}
                type="button"
                data-testid="history-version"
                aria-current={version.current}
                className={styles.row}
                onClick={() => onPreview(version.current ? null : version.versionId)}
              >
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{version.title}</span>
                  <span className={styles.rowMeta}>{meta}</span>
                </span>
                {version.current && <span className={styles.currentTag}>actuelle</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
