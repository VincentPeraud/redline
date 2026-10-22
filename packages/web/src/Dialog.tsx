import type { ReactNode } from "react";

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "grid", placeItems: "center" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        style={{ background: "#fff", borderRadius: 8, padding: 24, width: 480, maxWidth: "90vw" }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
