import type { ShareLinkView } from "@redline/shared";
import { Button, Logo, SegmentedControl, StatusBadge } from "./ui/index.js";
import { LEVEL_LABEL } from "./ProjectSharingDialog.js";
import { navigateTo, playRoute } from "./router.js";
import type { VisitorState } from "./visitor.js";
import styles from "./VisitorHeader.module.css";

/** What the badge of a link says: its level, with the person for an Écriture link ("Écriture · Alix"). */
export const linkBadgeLabel = (view: ShareLinkView): string => (view.level === "write" ? `${LEVEL_LABEL.write} · ${view.name}` : LEVEL_LABEL[view.level]);

/** Top bar of a share link: the page and its project, the link's level (never who shared it), the presentation, and Regarder / Commenter on a Commentaire link. */
export function VisitorHeader({ visitor, pageId, pageTitle, firstArtboard, picking, onPickingChange }: { visitor: VisitorState; pageId: string; pageTitle: string; firstArtboard?: string; picking: boolean; onPickingChange: (picking: boolean) => void }) {
  return (
    <header className={styles.header}>
      <span className={styles.logo}>
        <Logo wordmark={false} />
      </span>
      <div className={styles.title}>
        <strong>{pageTitle}</strong>
        {visitor.view.scope === "project" ? <a href="#/">{visitor.view.project.title}</a> : <span>{visitor.view.project.title}</span>}
      </div>
      <div className={styles.spacer} />
      <StatusBadge tone={visitor.view.level === "write" ? "accent" : "neutral"}>{linkBadgeLabel(visitor.view)}</StatusBadge>
      <Button disabled={firstArtboard === undefined} onClick={() => firstArtboard !== undefined && navigateTo(playRoute(pageId, firstArtboard))}>
        Présenter
      </Button>
      {visitor.view.level !== "read" && (
        <SegmentedControl
          ariaLabel="Mode du canvas"
          options={[
            { value: "look", label: visitor.view.level === "write" ? "Interagir (P)" : "Regarder" },
            { value: "comment", label: "Commenter (C)" },
          ]}
          value={picking ? "comment" : "look"}
          onChange={(mode) => onPickingChange(mode === "comment")}
        />
      )}
    </header>
  );
}
