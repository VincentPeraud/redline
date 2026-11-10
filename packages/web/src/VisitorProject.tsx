import { useEffect, useState } from "react";
import type { Page, Project, ProjectLinkPage } from "@redline/shared";
import { NewPageDialog } from "./NewPageDialog.js";
import { relativeTime } from "./relativeTime.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { navigateTo } from "./router.js";
import { Button, Logo, StatusBadge } from "./ui/index.js";
import { linkBadgeLabel } from "./VisitorHeader.js";
import type { VisitorState } from "./visitor.js";
import styles from "./VisitorProject.module.css";

const pageHref = (pageId: string) => `#/pages/${encodeURIComponent(pageId)}`;
const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? "s" : ""}`;

/** The page of a project link: the project's pages as cards, those created later included, the archived ones never. An Écriture link also starts new pages. */
export function VisitorProject({ visitor }: { visitor: VisitorState }) {
  const [pages, setPages] = useState<ProjectLinkPage[] | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const { project: shown, level } = visitor.view;

  async function load() {
    setPages((await (await fetch(`/api/projects/${shown.id}/pages`)).json()) as ProjectLinkPage[]);
  }
  useEffect(() => {
    void load();
    void fetch(`/api/projects/${shown.id}`).then(async (res) => setProject((await res.json()) as Project));
    return subscribeServerEvents((event) => {
      if (event.type === "page-updated" || event.type === "page-renamed" || event.type === "page-archive-changed") void load();
    });
  }, [shown.id]);

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <span className={styles.logo}>
          <Logo wordmark={false} />
        </span>
        <div className={styles.title}>
          <strong>{shown.title}</strong>
          <span>Projet partagé</span>
        </div>
        <div className={styles.spacer} />
        <StatusBadge tone={level === "write" ? "accent" : "neutral"}>{linkBadgeLabel(visitor.view)}</StatusBadge>
      </header>
      <main className={styles.main}>
        <div className={styles.heading}>
          <div>
            <h1>{shown.title}</h1>
            {pages && <p className={styles.meta}>{plural(pages.length, "page")} · les nouvelles pages apparaîtront ici</p>}
          </div>
          {level === "write" && (
            <Button variant="accent" onClick={() => setCreating(true)}>
              Nouvelle page
            </Button>
          )}
        </div>
        <div className={styles.grid}>
          {pages?.map((page) => (
            <a key={page.id} className={styles.card} href={pageHref(page.id)}>
              <div className={styles.thumb} aria-hidden="true">
                {Array.from({ length: Math.min(Math.max(page.artboardCount, 1), 3) }, (_, index) => (
                  <i key={index} />
                ))}
              </div>
              <div className={styles.body}>
                <strong>{page.title}</strong>
                <span>
                  {plural(page.artboardCount, "artboard")} · modifiée {relativeTime(page.updatedAt)}
                </span>
              </div>
            </a>
          ))}
        </div>
      </main>
      {creating && (
        <NewPageDialog
          projectId={shown.id}
          projectTitle={shown.title}
          designSystem={project?.designSystem ?? null}
          withInstructions={false}
          onClose={() => setCreating(false)}
          onCreated={(page: Page) => navigateTo({ name: "page", pageId: page.id })}
        />
      )}
    </div>
  );
}
