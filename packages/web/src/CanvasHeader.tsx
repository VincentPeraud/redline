import { useEffect, useRef, useState } from "react";
import type { Page, Project, Thread } from "@redline/shared";
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

function PageMenu({ project, pageId, pageTitle }: { project: Project | null; pageId: string; pageTitle: string }) {
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={root} className={styles.menuRoot}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} className={styles.pageButton} onClick={() => setOpen(!open)}>
        {pageTitle}
        <span aria-hidden="true" className={styles.chevron}>
          ▼
        </span>
      </button>
      {open && project && (
        <div role="menu" aria-label={`Pages du projet ${project.title}`} className={styles.menu}>
          <div className={styles.menuTitle}>Pages du projet</div>
          {pages.map(({ page, openThreads }) => (
            <a
              key={page.id}
              role="menuitem"
              href={routeHref({ name: "page", pageId: page.id })}
              className={cx(styles.menuItem, page.id === pageId && styles.menuItemCurrent)}
              onClick={() => setOpen(false)}
            >
              {page.title}
              <span className={styles.spacer} />
              {openThreads > 0 ? (
                <span className={styles.menuWarn}>{plural(openThreads, "fil", "fils")}</span>
              ) : null}
            </a>
          ))}
          <div className={styles.menuDivider} />
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
  pageId: string;
  pageTitle: string;
  picking: boolean;
  onPickingChange: (picking: boolean) => void;
  runningCount: number;
}

/** Top bar of the page canvas: logo, project / page breadcrumb with the page switcher, agent status and the interact / comment toggle. */
export function CanvasHeader({ project, pageId, pageTitle, picking, onPickingChange, runningCount }: Props) {
  return (
    <header className={styles.header}>
      <a href={routeHref({ name: "home" })} className={styles.logo} aria-label="Accueil">
        <Logo />
      </a>
      <nav aria-label="Fil d'Ariane" className={styles.crumbs}>
        {project && (
          <>
            <a href={routeHref({ name: "project", projectId: project.id })} className={styles.crumbLink}>
              {project.title}
            </a>
            <span aria-hidden="true">/</span>
          </>
        )}
        <PageMenu project={project} pageId={pageId} pageTitle={pageTitle} />
      </nav>
      <div className={styles.spacer} />
      <AgentPill project={project} running={runningCount} />
      <div role="group" aria-label="Mode du canvas" className={styles.modes}>
        <button type="button" aria-pressed={!picking} className={cx(styles.mode, !picking && styles.modeInteract)} onClick={() => onPickingChange(false)}>
          Interagir (P)
        </button>
        <button type="button" aria-pressed={picking} className={cx(styles.mode, picking && styles.modeComment)} onClick={() => onPickingChange(true)}>
          Commenter (C)
        </button>
      </div>
    </header>
  );
}
