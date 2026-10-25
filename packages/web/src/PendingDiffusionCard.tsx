import { pendingCardLabel } from "./diffusionLabels.js";
import { useDesignSystemDetail, useOpenDiffusionDialog } from "./DiffusionDialog.js";
import { Button } from "./ui/index.js";
import styles from "./PendingDiffusionCard.module.css";

/** "Pas encore diffusé" under Claude's answer when it changed a design system: what is pending, and the way to diffuse it. Nothing once the changes are diffused. */
export function PendingDiffusionCard({ designSystemId, refreshKey }: { designSystemId: string; refreshKey: string }) {
  const detail = useDesignSystemDetail(designSystemId, refreshKey);
  const open = useOpenDiffusionDialog();
  if (!detail || detail.pending.count === 0) return null;
  return (
    <div data-testid="pending-diffusion" className={styles.card}>
      <div className={styles.title}>
        <span aria-hidden="true" className={styles.dot} />
        Pas encore diffusé
      </div>
      <div className={styles.summary}>{pendingCardLabel(detail.pending, detail.usedBy.length)}</div>
      <Button variant="accent" className={styles.button} onClick={() => open(designSystemId)}>
        Diffuser…
      </Button>
    </div>
  );
}
