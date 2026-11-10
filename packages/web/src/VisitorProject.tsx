import { useEffect, useState } from "react";
import type { Page, Project, ProjectDesignSystem, ProjectLinkPage } from "@redline/shared";
import { NewPageDialog } from "./NewPageDialog.js";
import { ProjectPreview } from "./ProjectPreview.js";
import { previewSwatches } from "./projectDesignSystemLabels.js";
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
  const [designSystem, setDesignSystem] = useState<ProjectDesignSystem | null>(null);
  const { project: shown, level } = visitor.view;

  async function load() {
    setPages((await (await fetch(`/api/projects/${shown.id}/pages`)).json()) as ProjectLinkPage[]);
  }
  useEffect(() => {
    void load();
    void fetch(`/api/projects/${shown.id}`).then(async (res) => setProject((await res.json()) as Project));
    void fetch(`/api/projects/${shown.id}/design-system`).then(async (res) => setDesignSystem(res.ok ? ((await res.json()) as ProjectDesignSystem) : null));
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
      <div className={styles.layout}>
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
                <ProjectPreview pageId={page.id} height={150} />
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
      {designSystem?.designSystem && designSystem.diffusion && <DesignSystemPanel detail={designSystem} />}
      </div>
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

/** The design system the project's pages are drawn with, read-only: its colours, its name and diffusion. Its own pages are not part of the link. */
function DesignSystemPanel({ detail }: { detail: ProjectDesignSystem }) {
  return (
    <aside className={styles.aside} aria-label="Design system">
      <h2 className={styles.asideTitle}>Design system</h2>
      <div className={styles.ds}>
        <div className={styles.dsPreview} aria-hidden="true">
          {previewSwatches(detail).map((swatch, index) => (
            <span key={index} className={swatch.bordered ? `${styles.swatch} ${styles.swatchBordered}` : styles.swatch} style={{ background: swatch.value }} />
          ))}
          <span className={styles.aa}>Aa</span>
        </div>
        <div className={styles.dsInfo}>
          <strong>{detail.designSystem?.title}</strong>
          <span>diffusion {detail.diffusion?.number}</span>
        </div>
      </div>
      <p className={styles.hint}>Les pages de ce projet utilisent ce design system. Ses propres pages ne sont pas partagées par ce lien.</p>
    </aside>
  );
}
