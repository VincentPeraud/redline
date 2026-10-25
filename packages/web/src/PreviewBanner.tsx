import { useDesignSystemDetail, useOpenDiffusionDialog } from "./DiffusionDialog.js";
import { pendingScopeLabel } from "./diffusionLabels.js";
import styles from "./PreviewBanner.module.css";

/** Closes the tab the preview was opened in; a tab opened by hand cannot be closed by script, so it goes back to the page instead. */
function closePreview(leave: () => void) {
  window.close();
  setTimeout(() => {
    if (!window.closed) leave();
  }, 150);
}

/** Dark banner of a page previewed with the pending version of a design system (nothing is stored: only this viewer sees it). */
export function PreviewBanner({ designSystemId, onLeave }: { designSystemId: string; onLeave: () => void }) {
  const detail = useDesignSystemDetail(designSystemId);
  const open = useOpenDiffusionDialog();
  const scope = detail ? pendingScopeLabel(detail.pending) : "";
  return (
    <div role="region" aria-label="Aperçu" className={styles.banner}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span>
        <b>Aperçu</b> avec la version non diffusée de {detail?.title ?? ""}
        {scope && ` · ${scope}`} · visible par toi seul
      </span>
      <div className={styles.spacer} />
      {detail && detail.pending.count > 0 && (
        <button type="button" className={styles.diffuse} onClick={() => open(designSystemId)}>
          Diffuser
        </button>
      )}
      <button type="button" className={styles.close} onClick={() => closePreview(onLeave)}>
        Fermer l'aperçu
      </button>
    </div>
  );
}
