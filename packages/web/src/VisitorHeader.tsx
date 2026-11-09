import { Button, Logo, SegmentedControl, StatusBadge } from "./ui/index.js";
import { LEVEL_LABEL } from "./ProjectSharingDialog.js";
import { navigateTo, playRoute } from "./router.js";
import type { VisitorState } from "./visitor.js";
import styles from "./VisitorHeader.module.css";

/** Top bar of a share link: the page and its project, the link's level (never who shared it), the presentation, and Regarder / Commenter on a Commentaire link. */
export function VisitorHeader({ visitor, pageId, firstArtboard, picking, onPickingChange }: { visitor: VisitorState; pageId: string; firstArtboard?: string; picking: boolean; onPickingChange: (picking: boolean) => void }) {
  return (
    <header className={styles.header}>
      <span className={styles.logo}>
        <Logo wordmark={false} />
      </span>
      <div className={styles.title}>
        <strong>{visitor.view.page.title}</strong>
        <span>{visitor.view.project.title}</span>
      </div>
      <div className={styles.spacer} />
      <StatusBadge tone="neutral">{LEVEL_LABEL[visitor.view.level]}</StatusBadge>
      <Button disabled={firstArtboard === undefined} onClick={() => firstArtboard !== undefined && navigateTo(playRoute(pageId, firstArtboard))}>
        Présenter
      </Button>
      {visitor.view.level !== "read" && (
        <SegmentedControl
          ariaLabel="Mode du canvas"
          options={[
            { value: "look", label: "Regarder" },
            { value: "comment", label: "Commenter (C)" },
          ]}
          value={picking ? "comment" : "look"}
          onChange={(mode) => onPickingChange(mode === "comment")}
        />
      )}
    </header>
  );
}
