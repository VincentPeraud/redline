import { useId, useState } from "react";
import { cx } from "./ui/index.js";
import { tocGroups, type TocItem } from "./tocItems.js";
import styles from "./TocList.module.css";

interface Props {
  items: TocItem[];
  /** File of the highlighted line. */
  currentFile?: string;
  onSelect: (file: string) => void;
  autoFocusFilter?: boolean;
  placeholder?: string;
}

function threadLabel(count: number): string {
  return `${count} ${count === 1 ? "fil" : "fils"}`;
}

/** The page's artboards numbered in reading order under their group titles, with a filter. Shared by the header menu, the side panel tab and the play counter menu. */
export function TocList({ items, currentFile, onSelect, autoFocusFilter, placeholder = "Filtrer…" }: Props) {
  const [query, setQuery] = useState("");
  const filterId = useId();
  const groups = tocGroups(items, query);
  return (
    <>
      <div className={styles.filter}>
        <label htmlFor={filterId} className={styles.srOnly}>
          Filtrer les artboards
        </label>
        <input id={filterId} type="search" placeholder={placeholder} autoFocus={autoFocusFilter} value={query} onChange={(e) => setQuery(e.target.value)} className={styles.input} />
      </div>
      <div className={styles.groups}>
        {groups.map((group) => (
          <div key={group.title ?? "\u0000untitled"} role="group" aria-label={group.title ?? undefined}>
            {group.title !== null && <div className={styles.groupTitle}>{group.title}</div>}
            {group.items.map((item) => (
              <button
                key={item.file}
                type="button"
                role="menuitem"
                aria-current={item.file === currentFile}
                className={cx(styles.line, item.file === currentFile && styles.current)}
                onClick={() => onSelect(item.file)}
              >
                <span className={styles.number}>{item.number}</span>
                <span className={styles.title}>{item.title ?? item.file}</span>
                <span className={styles.file}>{item.file}</span>
                {item.openThreads > 0 && <span className={styles.threads}>{threadLabel(item.openThreads)}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
