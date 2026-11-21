import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DeletedArtboard, Gap, Page, PageGaps, Project } from "@redline/shared";
import { DiffuseButton } from "./DiffusionDialog.js";
import { DeletedArtboardsList } from "./DeletedArtboardsList.js";
import { GapsButton } from "./GapsReport.js";
import { ErrorsButton, type ArtboardErrorsEntry } from "./ArtboardErrors.js";
import { RenameForm, RenamePencil, renameHost } from "./Rename.js";
import { list } from "./reviewLabels.js";
import { TocMenu } from "./TocMenu.js";
import { ToTakeBadge } from "./ToTakeBadge.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { AccountMenu, displayName } from "./AccountMenu.js";
import { avatarClassName } from "./Avatar.js";
import { useMe, useWho } from "./useMe.js";
import type { Who } from "./historyLabels.js";
import type { TocItem } from "./tocItems.js";
import { navigateTo, playRoute, routeHref } from "./router.js";
import { Button, Logo, cx } from "./ui/index.js";
import { VisitorHeader } from "./VisitorHeader.js";
import { SharePageButton } from "./PageSharing.js";
import { useVisitor } from "./visitor.js";
import styles from "./CanvasHeader.module.css";

/** "créée par Claude · pour Ariane Martin", "créée par Toi"; without SSO only Claude's pages say who made them. */
function createdByLabel(page: Page, who: Who): string | null {
  if (page.createdBy === "claude") return who.name ? `créée par Claude · pour ${who.name}` : "créée par Claude";
  return who.sso && who.name ? `créée par ${who.name}` : null;
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
    <div data-testid="canvas-agent" className={cx(styles.pill, !online && styles.pillOff)} title={`Agent ${folderName(agent.folder)} · ${state}`}>
      <span aria-hidden="true" className={cx(styles.dot, !online && styles.dotOff)} />
      <span className={styles.pillText}>
        Agent {folderName(agent.folder)} · {state}
      </span>
    </div>
  );
}

/** What a page belongs to: a project, or a design system for its own pages. */
interface PageOwner {
  id: string;
  title: string;
  kind: "project" | "designSystem";
}

const OWNER_LABELS = {
  project: { pages: "Pages du projet", overview: "Vue du projet" },
  designSystem: { pages: "Pages du design system", overview: "Vue du design system" },
} as const;

function ownerHref(owner: PageOwner): string {
  return owner.kind === "project" ? routeHref({ name: "project", projectId: owner.id }) : routeHref({ name: "designSystem", designSystemId: owner.id });
}

interface PageMenuProps {
  owner: PageOwner | null;
  pageId: string;
  pageTitle: string;
  artboardOrigin: string;
  deleted: DeletedArtboard[];
  onPutBack: (item: DeletedArtboard) => Promise<void>;
  onRenamePage: (title: string) => Promise<void>;
  /** Design system whose draft the page is previewed with: the menu keeps the preview from page to page and offers no edit. */
  previewOf?: string;
  /** An archived project's page: no rename. */
  archived?: boolean;
}

function PageMenu({ owner, pageId, pageTitle, artboardOrigin, deleted, onPutBack, onRenamePage, previewOf, archived = false }: PageMenuProps) {
  const who = useWho();
  const [open, setOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const root = useRef<HTMLDivElement>(null);

  // A long list opens on the current page, once: thread counts arriving later do not scroll it back.
  useEffect(() => {
    if (open) root.current?.querySelector('[role="menu"] [aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [open, pages.length]);

  useEffect(() => {
    if (!open || !owner) return;
    let cancelled = false;
    // The list carries each page's thread counts; it loads again when a thread or a comment mode changes while the menu is open.
    const load = async () => {
      const response = await fetch(`/api/projects/${owner.id}/pages`).catch(() => undefined);
      const list = response?.ok ? ((await response.json().catch(() => undefined)) as Page[] | undefined) : undefined;
      if (list && !cancelled) setPages(list);
    };
    void load();
    const unsubscribe = subscribeServerEvents(
      (event) => {
        if (event.type === "thread-updated" || event.type === "comment-mode-changed" || event.type === "queue-updated") void load();
      },
      () => void load(),
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, owner?.id]);

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
    if (!owner) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        window.location.hash = ownerHref(owner);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [owner?.id, owner?.kind]);

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
        {previewOf === undefined && !archived && <RenamePencil label="Renommer la page" size="bare" onClick={() => setRenaming(true)} />}
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
      {open && owner && (
        <div role="menu" aria-label={`${OWNER_LABELS[owner.kind].pages} ${owner.title}`} className={styles.menu}>
          <div className={styles.menuTitle}>Pages de {owner.title}</div>
          <div className={styles.menuPages}>
          {pages.map((page) => (
            <a
              key={page.id}
              role="menuitem"
              href={routeHref({ name: "page", pageId: page.id, ...(previewOf === undefined ? {} : { previewOf }) })}
              className={cx(styles.menuItem, page.id === pageId && styles.menuItemCurrent)}
              aria-current={page.id === pageId ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              <span className={styles.menuPageTitle}>{page.title}</span>
              <span className={styles.spacer} />
              {createdByLabel(page, who(page.createdByPerson)) ? <span className={styles.menuMuted}>{createdByLabel(page, who(page.createdByPerson))}</span> : null}
              {(page.openThreadCount ?? 0) > 0 ? <span className={styles.menuWarn}>{plural(page.openThreadCount!, "fil", "fils")}</span> : null}
              <ToTakeBadge count={page.toTakeCount ?? 0} />
            </a>
          ))}
          </div>
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
          <a role="menuitem" href={ownerHref(owner)} className={cx(styles.menuItem, styles.menuItemPlain)}>
            {OWNER_LABELS[owner.kind].overview}
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
  /** Set on a design system's own page only. */
  designSystemId?: string;
  /** The design system's title, on its own pages: the breadcrumb and the page menu name it. */
  designSystemTitle?: string;
  /** Design system pages: titles of the projects that follow its draft and so see a publish right away. */
  followedBy?: string[];
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
  /** An archived project's (or design system's) page: no comment mode, no agent, no diffusion, nothing to ask Claude. */
  archived?: boolean;
  /** The viewer's level lets them comment but not work: the header keeps the comment mode and drops the agent controls (with `archived`). */
  commentOnly?: boolean;
  /** The comment mode toggle, left of the agent pill (a link visitor's header too); absent on a design system's page, an archived page and a preview. */
  commentMode?: ReactNode;
  /** Design system gaps of the page; the button shows only when there are some. */
  gaps: PageGaps | null;
  gapExceptionCount: number;
  onSeeGap: (gap: Gap) => void;
  onGapException: (gap: Gap) => void;
  onShowGapExceptions: () => void;
  onAskFixGaps: () => void;
  /** Artboards whose iframes reported errors; the button shows only when there are some. */
  errors: ArtboardErrorsEntry[];
  onSeeErrors: (file: string) => void;
  onAskFixErrors: () => void;
}

/** Top bar of the page canvas: logo, project / page breadcrumb with the page switcher, agent status and the interact / comment toggle. */
export function CanvasHeader({ project, designSystemId, designSystemTitle, followedBy = [], versionId, pageId, pageTitle, picking, onPickingChange, runningCount, artboardOrigin, deleted, onPutBack, onRenamePage, toc, gaps, gapExceptionCount, onSeeGap, onGapException, onShowGapExceptions, onAskFixGaps, errors, onSeeErrors, onAskFixErrors, previewOf, archived = false, commentOnly = false, commentMode }: Props) {
  const me = useMe();
  const visitor = useVisitor();
  const owner: PageOwner | null = project
    ? { id: project.id, title: project.title, kind: "project" }
    : designSystemId && designSystemTitle
      ? { id: designSystemId, title: designSystemTitle, kind: "designSystem" }
      : null;
  if (visitor) return <VisitorHeader commentMode={commentMode} visitor={visitor} pageId={pageId} pageTitle={pageTitle} firstArtboard={toc.items[0]?.file} picking={picking} onPickingChange={onPickingChange} />;
  // Same button as a share link's top bar: plays the page from its first artboard in reading order.
  const firstArtboard = toc.items[0]?.file;
  const present = (
    <Button disabled={firstArtboard === undefined} onClick={() => firstArtboard !== undefined && navigateTo(playRoute(pageId, firstArtboard))}>
      Présenter
    </Button>
  );
  return (
    <header className={styles.header}>
      <a href={routeHref({ name: "home" })} className={styles.logo} aria-label="Accueil">
        <Logo />
      </a>
      <nav aria-label="Fil d'Ariane" className={styles.crumbs}>
        {owner && (
          <>
            {previewOf === undefined ? (
              <a href={ownerHref(owner)} className={styles.crumbLink}>
                {owner.title}
              </a>
            ) : (
              <span>{owner.title}</span>
            )}
            <span aria-hidden="true">/</span>
          </>
        )}
        <PageMenu
          owner={owner}
          pageId={pageId}
          pageTitle={pageTitle}
          artboardOrigin={artboardOrigin}
          deleted={deleted}
          onPutBack={onPutBack}
          onRenamePage={onRenamePage}
          previewOf={previewOf}
          archived={archived}
        />
      </nav>
      {previewOf === undefined && (
        <>
          {!archived && (
            <div className={styles.signals}>
              <GapsButton report={gaps} exceptionCount={gapExceptionCount} onSee={onSeeGap} onException={onGapException} onAsk={onAskFixGaps} onShowExceptions={onShowGapExceptions} />
              <ErrorsButton entries={errors} onSee={onSeeErrors} onAsk={onAskFixErrors} />
            </div>
          )}
          <TocMenu {...toc} />
          {followedBy.length > 0 && !archived && <span className={styles.draftVisibility}>Publié ici, visible tout de suite dans {list(followedBy)}</span>}
        </>
      )}
      <div className={styles.spacer} />
      {previewOf !== undefined ? (
        <div className={styles.previewNote}>Commentaires et conversations désactivés pendant l'aperçu</div>
      ) : archived && !commentOnly ? (
        <>
          {commentMode && <div className={styles.commentMode}>{commentMode}</div>}
          {present}
        </>
      ) : (
        <>
          {!archived && <DiffuseButton designSystemId={designSystemId} refreshKey={versionId} />}
          {commentMode && <div className={styles.commentMode}>{commentMode}</div>}
          {!archived && <AgentPill project={project} running={runningCount} />}
          {!archived && !designSystemId && <SharePageButton pageId={pageId} pageTitle={pageTitle} project={project} />}
          {present}
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
      {me && (
        <AccountMenu
          me={me}
          placement="down"
          trigger={(props) => (
            <button type="button" data-testid="account-pill" aria-label={`Compte : ${displayName(me)}`} className={cx(avatarClassName, styles.accountPill)} {...props}>
              {me.initials}
            </button>
          )}
        />
      )}
    </header>
  );
}
