import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { counted } from "./plural.js";
import { Button, Tooltip } from "./ui/index.js";
import { useCloseOnOutsidePointer } from "./useCloseOnOutsidePointer.js";
import styles from "./ArtboardErrors.module.css";

/** What went wrong in one artboard, as its iframes reported it. */
export interface ArtboardErrorsEntry {
  file: string;
  title: string;
  errors: string[];
}

/** Receives the error list of one iframe (`frameId`); an empty list clears it. Set per artboard by the canvas, a no-op elsewhere. */
export const ArtboardErrorsContext = createContext<(frameId: string, errors: string[]) => void>(() => undefined);

/** "1 erreur", "3 erreurs". */
export const errorCountLabel = (count: number): string => counted(count, "erreur", "erreurs");

/** The conversation message of "Demander à Claude de corriger". */
export function fixErrorsMessage(entries: readonly ArtboardErrorsEntry[]): string {
  const total = entries.reduce((sum, entry) => sum + entry.errors.length, 0);
  return [
    `Corrige ces ${errorCountLabel(total)} : ces artboards ne s'affichent pas comme prévu dans le navigateur.`,
    "",
    ...entries.flatMap((entry) => [`${entry.file} :`, ...entry.errors.map((error) => `- ${error}`)]),
  ].join("\n");
}

/** "● N erreurs" next to the gaps button and its list by artboard; nothing while no artboard reported an error. */
export function ErrorsButton({ entries, onSee, onAsk }: { entries: readonly ArtboardErrorsEntry[]; onSee: (file: string) => void; onAsk: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsidePointer(root, open, close);
  // Once every error is fixed the button goes away: it comes back closed.
  useEffect(() => {
    if (entries.length === 0) setOpen(false);
  }, [entries.length]);
  if (entries.length === 0) return null;
  const label = errorCountLabel(entries.reduce((sum, entry) => sum + entry.errors.length, 0));
  const trigger = (
    <button type="button" data-testid="errors-button" aria-haspopup="dialog" aria-expanded={open} className={styles.button} onClick={() => setOpen(!open)}>
      <span aria-hidden="true" className={styles.dot} />
      {label}
    </button>
  );
  return (
    <div ref={root} className={styles.root}>
      {open ? trigger : <Tooltip label="Erreurs des artboards">{trigger}</Tooltip>}
      {open && (
        <div role="dialog" aria-label="Erreurs des artboards" className={styles.popover} onKeyDown={(event) => event.key === "Escape" && close()}>
          <div className={styles.head}>
            <div className={styles.title}>Erreurs des artboards</div>
            <div className={styles.lead}>Ces artboards ne s'affichent pas comme prévu.</div>
          </div>
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.file} data-errors-of={entry.file} className={styles.row}>
                <div className={styles.rowTop}>
                  <span className={styles.name}>{entry.title}</span>
                  <span className={styles.file}>{entry.file}</span>
                  <span className={styles.spacer} />
                  <Button
                    size="sm"
                    className={styles.rowButton}
                    onClick={() => {
                      close();
                      onSee(entry.file);
                    }}
                  >
                    Voir
                  </Button>
                </div>
                {entry.errors.map((error) => (
                  <div key={error} data-error className={styles.message}>
                    {error}
                  </div>
                ))}
              </li>
            ))}
          </ul>
          <div className={styles.footer}>
            <span className={styles.spacer} />
            <Button
              variant="accent"
              className={styles.ask}
              onClick={() => {
                close();
                onAsk();
              }}
            >
              Demander à Claude de corriger
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
