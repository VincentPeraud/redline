import { useEffect, useRef, useState } from "react";
import type { DeletedArtboard, Gap, Page, PageGaps, Project, Thread } from "@redline/shared";
import { DiffuseButton } from "./DiffusionDialog.js";
import { DeletedArtboardsList } from "./DeletedArtboardsList.js";
import { GapsButton } from "./GapsReport.js";
import { RenameForm, RenamePencil, renameHost } from "./Rename.js";
import { TocMenu } from "./TocMenu.js";
import type { TocItem } from "./tocItems.js";
import { routeHref } from "./router.js";
import { Logo, cx } from "./ui/index.js";
import styles from "./CanvasHeader.module.css";

interface MenuPage {
  page: Page;
  openThreads: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count <= 1 ? one : many}`;
}

function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).pop() ?? folder;
}

function AgentPill({ project, running }: { project: Project | null; running: number }) {
  const agent = project?.servedBy ?? project?.agent;
  if (!agent) return <div className={cx(styles.pill, styles.pillOff)}>Aucun agent</div>;
  const online = project?.servedBy !== undefined;
  const state = !online ? "hors ligne" : running === 0 ? "aucune session en cours" : plural(running, "session en cours", "sessions en cours");
  return (
    <div data-testid="canvas-agent" className={cx(styles.pill, !online && styles.pillOff)}>
      <span aria-hidden="true" className={cx(styles.dot, !online && styles.dotOff)} />
      Agent {folderName(agent.folder)} · {state}
    </div>
  );
}

interface PageMenuProps {
  project: Project | null;
  pageId: string;
  pageTitle: string;
  artboardOrigin: string;
  deleted: DeletedArtboard[];
  onPutBack: (item: DeletedArtboard) => Promise<void>;
  onRenamePage: (title: string) => Promise<void>;
  /** Design system whose draft the page is previewed with: the menu keeps the preview from page to page and offers no edit. */
  previewOf?: string;
}

function PageMenu({ project, pageId, pageTitle, artboardOrigin, deleted, onPutBack, onRenamePage, previewOf }: PageMenuProps) {
  const [open, setOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [pages, setPages] = useState<MenuPage[]>([]);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !project) return;
    let cancelled = false;
    void (async () => {
      const list = (await (await fetch(`/api/projects/${project.id}/pages`)).json()) as Page[];
      const withCounts = await Promise.all(
        list.map(async (page) => {
          const threads = (await (await fetch(`/api/pages/${page.id}/threads`)).json()) as Thread[];
          return { page, openThreads: threads.filter((t) => t.status === "open").length };
        }),
      );
      if (!cancelled) setPages(withCounts);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!project) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        window.location.hash = routeHref({ name: "project", projectId: project.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);

  if (renaming) {
    return (
      <RenameForm
        label="Nom de la page"
        value={pageTitle}
        size="bare"
        onSave={async (title) => {
          await onRenamePage(title);
          setRenaming(false);
        }}
        onCancel={() => setRenaming(false)}
      />
    );
  }

  return (
    <div ref={root} className={cx(styles.menuRoot, renameHost)}>
      <div className={styles.pageRow}>
        <button type="button" aria-haspopup="menu" aria-expanded={open} className={styles.pageButton} onClick={() => setOpen(!open)}>
          {pageTitle}
          <span aria-hidden="true" className={styles.chevron}>
            ▼
          </span>
        </button>
        {previewOf === undefined && <RenamePencil label="Renommer la page" size="bare" onClick={() => setRenaming(true)} />}
      </div>
      {deletedOpen && (
        <DeletedArtboardsList
          pageId={pageId}
          pageTitle={pageTitle}
          artboardOrigin={artboardOrigin}
          items={deleted}
          onPutBack={async (item) => {
            await onPutBack(item);
            setDeletedOpen(false);
          }}
          onClose={() => setDeletedOpen(false)}
        />
      )}
      {open && project && (
        <div role="menu" aria-label={`Pages du projet ${project.title}`} className={styles.menu}>
          <div className={styles.menuTitle}>Pages du projet</div>
          {pages.map(({ page, openThreads }) => (
            <a
              key={page.id}
              role="menuitem"
              href={routeHref({ name: "page", pageId: page.id, ...(previewOf === undefined ? {} : { previewOf }) })}
              className={cx(styles.menuItem, page.id === pageId && styles.menuItemCurrent)}
              onClick={() => setOpen(false)}
            >
              {page.title}
              <span className={styles.spacer} />
              {page.createdBy === "claude" ? <span className={styles.menuMuted}>créée par Claude</span> : null}
              {openThreads > 0 ? <span className={styles.menuWarn}>{plural(openThreads, "fil", "fils")}</span> : null}
            </a>
          ))}
          <div className={styles.menuDivider} />
          {deleted.length > 0 && (
            <button
              type="button"
              role="menuitem"
              className={cx(styles.menuItem, styles.menuButton)}
              onClick={() => {
                setOpen(false);
                setDeletedOpen(true);
              }}
            >
              Artboards supprimés
              <span className={styles.spacer} />
              <span className={styles.menuMuted}>{deleted.length}</span>
            </button>
          )}
          <a role="menuitem" href={routeHref({ name: "project", projectId: project.id })} className={cx(styles.menuItem, styles.menuItemPlain)}>
            Vue du projet
            <span className={styles.spacer} />
            <span className={styles.menuKey}>⌘K</span>
          </a>
        </div>
      )}
    </div>
  );
}

interface Props {
  project: Project | null;
  /** The project id; `DiffuseButton` shows only when it is a design system with pending changes. */
  designSystemId: string;
  versionId: string;
  pageId: string;
  pageTitle: string;
  picking: boolean;
  onPickingChange: (picking: boolean) => void;
  runningCount: number;
  artboardOrigin: string;
  deleted: DeletedArtboard[];
  onPutBack: (item: DeletedArtboard) => Promise<void>;
  onRenamePage: (title: string) => Promise<void>;
  toc: { items: TocItem[]; currentFile?: string; onSelect: (file: string) => void };
  /** Design system whose draft the page is previewed with: the header is then read-only (no comment mode, no agent, no diffusion). */
  previewOf?: string;
  /** Design system gaps of the page; the button shows only when there are some. */
  gaps: PageGaps | null;
  onSeeGap: (gap: Gap) => void;
}

/** Top bar of the page canvas: logo, project / page breadcrumb with the page switcher, agent status and the interact / comment toggle. */
export function CanvasHeader({ project, designSystemId, versionId, pageId, pageTitle, picking, onPickingChange, runningCount, artboardOrigin, deleted, onPutBack, onRenamePage, toc, gaps, onSeeGap, previewOf }: Props) {
  return (
    <header className={styles.header}>
      <a href={routeHref({ name: "home" })} className={styles.logo} aria-label="Accueil">
        <Logo />
      </a>
      <nav aria-label="Fil d'Ariane" className={styles.crumbs}>
        {project && (
          <>
            {previewOf === undefined ? (
              <a href={routeHref({ name: "project", projectId: project.id })} className={styles.crumbLink}>
                {project.title}
              </a>
            ) : (
              <span>{project.title}</span>
            )}
            <span aria-hidden="true">/</span>
          </>
        )}
        <PageMenu
          project={project}
          pageId={pageId}
          pageTitle={pageTitle}
          artboardOrigin={artboardOrigin}
          deleted={deleted}
          onPutBack={onPutBack}
          onRenamePage={onRenamePage}
          previewOf={previewOf}
        />
      </nav>
      {previewOf === undefined && (
        <>
          <GapsButton report={gaps} onSee={onSeeGap} />
          <TocMenu {...toc} />
        </>
      )}
      <div className={styles.spacer} />
      {previewOf !== undefined ? (
        <div className={styles.previewNote}>Commentaires et conversations désactivés pendant l'aperçu</div>
      ) : (
        <>
          <DiffuseButton designSystemId={designSystemId} refreshKey={versionId} />
          <AgentPill project={project} running={runningCount} />
          <div role="group" aria-label="Mode du canvas" className={styles.modes}>
            <button type="button" aria-pressed={!picking} className={cx(styles.mode, !picking && styles.modeInteract)} onClick={() => onPickingChange(false)}>
              Interagir (P)
            </button>
            <button type="button" aria-pressed={picking} className={cx(styles.mode, picking && styles.modeComment)} onClick={() => onPickingChange(true)}>
              Commenter (C)
            </button>
          </div>
        </>
      )}
    </header>
  );
}
