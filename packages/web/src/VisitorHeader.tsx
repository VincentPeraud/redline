import { Button, Logo, StatusBadge } from "./ui/index.js";
import { LEVEL_LABEL } from "./ProjectSharingDialog.js";
import { navigateTo, playRoute } from "./router.js";
import type { VisitorState } from "./visitor.js";
import styles from "./VisitorHeader.module.css";

/** Top bar of a share link: the page and its project, the link's level (never who shared it), and the presentation. */
export function VisitorHeader({ visitor, pageId, firstArtboard }: { visitor: VisitorState; pageId: string; firstArtboard?: string }) {
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
    </header>
  );
}
