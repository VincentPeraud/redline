import { ArtboardIframe } from "./artboardCapability.js";
import { useEffect, useRef } from "react";
import { versionPreviewPath, type DeletedArtboard } from "@redline/shared";
import { designMdAuthor, historyDate, metaLine, originLabel, type Who } from "./historyLabels.js";
import { useWho } from "./useMe.js";
import styles from "./DeletedArtboardsList.module.css";

const BOX_WIDTH = 34;
const BOX_HEIGHT = 48;

function Thumbnail({ pageId, artboardOrigin, item }: { pageId: string; artboardOrigin: string; item: DeletedArtboard }) {
  const scale = Math.min((BOX_WIDTH - 2) / item.width, (BOX_HEIGHT - 2) / item.height);
  return (
    <div className={styles.thumb} aria-hidden="true">
      <ArtboardIframe
        sandbox="allow-scripts"
        tabIndex={-1}
        title={`Aperçu de ${item.file}`}
        src={`${artboardOrigin}${versionPreviewPath(pageId, item.lastVersionId, item.file)}`}
        className={styles.thumbFrame}
        style={{ width: item.width, height: item.height, transform: `scale(${scale})` }}
      />
    </div>
  );
}

/** "Claude · fil « … », demandé par Toi", "Claude · terminal", "Ariane Martin", "toi" without SSO; empty when nobody is known. */
function deletedBy(item: DeletedArtboard, who: Who): string {
  if (item.deletedBy === "claude") {
    if (item.origin === "thread" || item.origin === "conversation") return who.sso ? originLabel(item.origin, item.originLabel, who) : designMdAuthor(item.origin, item.originLabel);
    return "Claude · terminal";
  }
  return who.sso ? (who.name ?? "") : "toi";
}

interface Props {
  pageId: string;
  pageTitle: string;
  artboardOrigin: string;
  items: DeletedArtboard[];
  onPutBack: (item: DeletedArtboard) => Promise<void>;
  onClose: () => void;
}

/** Popover "Artboards supprimés · <page>": what was removed from the page, with "Remettre". */
export function DeletedArtboardsList({ pageId, pageTitle, artboardOrigin, items, onPutBack, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const who = useWho();

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={root} role="dialog" aria-label="Artboards supprimés" className={styles.popover}>
      <div className={styles.title}>Artboards supprimés · {pageTitle}</div>
      {items.map((item) => {
        const by = deletedBy(item, who(item.person));
        return (
          <div key={item.file} data-testid="deleted-artboard" className={styles.row}>
            <Thumbnail pageId={pageId} artboardOrigin={artboardOrigin} item={item} />
            <div className={styles.text}>
              <div className={styles.file}>{item.file}</div>
              <div className={styles.meta}>
                {metaLine(by && `Supprimé par ${by}`, historyDate(item.deletedAt))}
              </div>
            </div>
            <button type="button" className={styles.putBack} onClick={() => void onPutBack(item)}>
              Remettre
            </button>
          </div>
        );
      })}
      <div className={styles.note}>« Remettre » le replace à son ancienne position, dans son dernier état avant suppression.</div>
    </div>
  );
}
