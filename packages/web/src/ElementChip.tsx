import type { ThreadTarget } from "@redline/shared";
import { chipParts } from "./elementChips.js";
import { Tooltip, cx } from "./ui/index.js";
import styles from "./ElementChip.module.css";

interface Props {
  number: number;
  target: ThreadTarget;
  /** Absent in the history, where a chip is only read. */
  onRemove?: () => void;
}

/** "1 Bouton · Réserver ma place ×": a target the user points at in a message. */
export function ElementChip({ number, target, onRemove }: Props) {
  const { kind, name } = chipParts(target);
  return (
    <span data-testid={onRemove ? "composer-chip" : "history-chip"} className={cx(styles.chip, !onRemove && styles.readOnly)}>
      <span className={styles.number}>{number}</span>
      <span className={styles.kind}>{name ? `${kind} ·` : kind}</span>
      {name && <span className={styles.name}>{name}</span>}
      {onRemove && (
        <Tooltip label={`Retirer ${name ?? kind}`}>
          <button type="button" aria-label={`Retirer ${name ?? kind}`} className={styles.remove} onClick={onRemove}>
            ×
          </button>
        </Tooltip>
      )}
    </span>
  );
}
