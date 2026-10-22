import { useEffect, useRef } from "react";
import styles from "./UndoToast.module.css";

export const UNDO_TOAST_MS = 10_000;

interface Props {
  message: string;
  onUndo: () => void;
  onExpire: () => void;
}

/** "<what happened> · Annuler": gone after ten seconds. */
export function UndoToast({ message, onUndo, onExpire }: Props) {
  const expire = useRef(onExpire);
  expire.current = onExpire;
  useEffect(() => {
    const timer = setTimeout(() => expire.current(), UNDO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div role="status" data-testid="undo-toast" className={styles.toast}>
      <span>{message}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className={styles.undo} onClick={onUndo}>
        Annuler
      </button>
    </div>
  );
}
