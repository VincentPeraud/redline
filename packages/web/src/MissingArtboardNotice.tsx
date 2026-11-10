import { Tooltip, cx } from "./ui/index.js";
import styles from "./MissingArtboardNotice.module.css";

/** Dismissable "Cet artboard n'existe plus · <file>" status; the caller positions it through `className`. */
export function MissingArtboardNotice({ file, onClose, className }: { file: string; onClose: () => void; className?: string }) {
  return (
    <div role="status" className={cx(styles.notice, className)}>
      Cet artboard n'existe plus · {file}
      <Tooltip label="Fermer">
        <button type="button" aria-label="Fermer" className={styles.close} onClick={onClose}>
          ×
        </button>
      </Tooltip>
    </div>
  );
}
