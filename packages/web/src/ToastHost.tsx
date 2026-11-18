import { dismissToast, useToasts } from "./toasts.js";
import styles from "./ToastHost.module.css";

/** The toasts of the app, stacked at the bottom centre of the screen; mounted once, at the root. */
export function ToastHost() {
  const toasts = useToasts();
  return (
    <div className={styles.host}>
      {toasts.map((toast) => (
        <div key={toast.id} role={toast.tone === "error" ? "alert" : "status"} data-testid="toast" data-closing={toast.closing || undefined} className={styles.toast}>
          <span className={styles.message}>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                toast.action?.onClick();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          {toast.tone === "error" && (
            <button type="button" aria-label="Fermer" className={styles.close} onClick={() => dismissToast(toast.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
