import { useEffect, useRef, useState } from "react";
import { Tooltip, cx } from "./ui/index.js";
import styles from "./Rename.module.css";

export type RenameSize = "project" | "page" | "bare";

function PencilIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13 7l4 4" />
    </svg>
  );
}

/** Pencil next to a title: hidden until the host (`.renameHost`) is hovered or the button is focused. */
export function RenamePencil({ label, size, onClick }: { label: string; size: RenameSize; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} className={cx(styles.pencil, styles[`pencil-${size}`])} onClick={onClick}>
        <PencilIcon size={size === "project" ? 18 : 15} />
      </button>
    </Tooltip>
  );
}

export const renameHost = styles.renameHost!;

/** The pencil's look and hover reveal, for another icon button beside it (a page card's archive icon). */
export const hostRevealButton = (size: RenameSize) => cx(styles.pencil, styles[`pencil-${size}`]);

interface FormProps {
  label: string;
  value: string;
  size: RenameSize;
  /** Rejects when the server refuses; the form then stays open. */
  onSave: (title: string) => Promise<void>;
  onCancel: () => void;
  /** Texts of the two buttons beside the field ("Renommer" / "OK"); none for the bare variant. */
  saveLabel?: string;
}

/** Inline title editor: Enter saves, Escape cancels, an empty name is refused. */
export function RenameForm({ label, value, size, onSave, onCancel, saveLabel }: FormProps) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const empty = draft.trim() === "";

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function save() {
    if (empty || saving) return;
    setSaving(true);
    try {
      await onSave(draft.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cx(styles.form, styles[`form-${size}`])}>
      <input
        ref={input}
        aria-label={label}
        aria-invalid={empty}
        value={draft}
        maxLength={120}
        className={cx(styles.input, styles[`input-${size}`])}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {saveLabel && (
        <>
          <button type="button" className={cx(styles.save, styles[`save-${size}`])} disabled={empty} onClick={() => void save()}>
            {saveLabel}
          </button>
          <button type="button" className={cx(styles.cancel, styles[`cancel-${size}`])} onClick={onCancel}>
            Annuler
          </button>
        </>
      )}
    </div>
  );
}
