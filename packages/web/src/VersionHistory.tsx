import { useEffect, useState } from "react";
import type { VersionOrigin } from "@redline/shared";
import { relativeTime } from "./relativeTime.js";
import { Button, Dialog, StatusBadge } from "./ui/index.js";
import styles from "./VersionHistory.module.css";

const ORIGIN_LABEL: Record<VersionOrigin, string> = {
  creation: "Création",
  thread: "Commentaire",
  conversation: "Conversation",
  terminal: "Terminal",
  tweak: "Tweak",
  restore: "Restauration",
};

interface VersionSummary {
  id: string;
  message: string;
  origin: string;
  createdAt: string;
}

interface Props {
  pageId: string;
  pageTitle: string;
  /** Current version of the page; the list reloads when it changes. */
  versionId: string;
  onRestored: () => void;
  onClose: () => void;
}

/** Versions of a page, newest first, with the origin of each and "Restaurer" on the older ones. */
export function VersionHistory({ pageId, pageTitle, versionId, onRestored, onClose }: Props) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);

  useEffect(() => {
    fetch(`/api/pages/${pageId}/versions`)
      .then((res) => res.json() as Promise<VersionSummary[]>)
      .then(setVersions);
  }, [pageId, versionId]);

  async function restore(id: string) {
    await fetch(`/api/pages/${pageId}/versions/${id}/restore`, { method: "POST" });
    onRestored();
  }

  return (
    <Dialog title="Historique des versions" onClose={onClose} width={520}>
      <ol aria-label={`Versions de ${pageTitle}`} className={styles.list}>
        {versions.map((version) => (
          <li key={version.id} className={styles.item}>
            <div className={styles.text}>
              <span className={styles.message}>{version.message}</span>
              <span className={styles.meta}>
                <StatusBadge tone="neutral" size="sm">
                  {ORIGIN_LABEL[version.origin as VersionOrigin] ?? version.origin}
                </StatusBadge>
                {relativeTime(version.createdAt)}
              </span>
            </div>
            {version.id === versionId ? (
              <StatusBadge tone="success" size="sm">
                actuelle
              </StatusBadge>
            ) : (
              <Button size="sm" onClick={() => void restore(version.id)}>
                Restaurer
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
