import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  type DesignMdInfo,
  type DesignMdResponse,
  type Page,
  type PageVersionSummary,
  type Project,
  type ProjectDesignSystem,
  type ProjectAsset,
  type Thread,
} from "@redline/shared";
import { AgentPill } from "./AgentPill.js";
import { ArchiveFooter, ArchiveIcon, ArchivedBanner, DeleteSection, PageArchiveButton, pageArchivedOnLabel } from "./ArchiveControls.js";
import { dayLabel, designMdStatus } from "./historyLabels.js";
import { useWho } from "./useMe.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { NewPageDialog } from "./NewPageDialog.js";
import { PageThumbnail, usePageArtboards } from "./PageThumbnail.js";
import { overrideCountLabel, projectComponentCountLabel } from "./diffusionLabels.js";
import { counted } from "./plural.js";
import { previewSwatches } from "./projectDesignSystemLabels.js";
import { relativeTime } from "./relativeTime.js";
import { RenameForm, RenamePencil, renameHost } from "./Rename.js";
import { navigateTo, routeHref } from "./router.js";
import { Button, Logo, PageContent, SidePanel, SidePanelBody, StatusBadge, cx } from "./ui/index.js";
import styles from "./ProjectOverview.module.css";

interface PageStats {
  openThreads: number;
  threads: number;
  versions: number;
  updatedAt: string | null;
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const FONT_EXTENSION = /\.(woff2?|ttf|otf)$/i;

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function PageCard({
  page,
  stats,
  artboardOrigin,
  current,
  readOnly,
  onRename,
  onArchived,
}: {
  page: Page;
  stats: PageStats | undefined;
  artboardOrigin: string;
  current: boolean;
  readOnly: boolean;
  onRename: (title: string) => Promise<void>;
  onArchived: () => void;
}) {
  const artboards = usePageArtboards(page.id, page.version.files);
  const [renaming, setRenaming] = useState(false);
  const count = counted(artboards?.length ?? 0, "artboard", "artboards");
  // An archived project's cards say what the page holds (and would be deleted with it), not when it last changed; an archived page's card, when it was archived.
  const modified = page.archivedAt
    ? ` · ${pageArchivedOnLabel(page.archivedAt)}`
    : readOnly
      ? ` · ${counted(stats?.threads ?? 0, "fil", "fils")}`
      : stats?.updatedAt
        ? ` · modifié ${relativeTime(stats.updatedAt)}`
        : "";

  return (
    <div data-testid="page-card" className={cx(styles.pageCard, renameHost, current && styles.pageCardCurrent, page.archivedAt && styles.pageCardArchived)}>
      <PageThumbnail pageId={page.id} artboards={artboards} artboardOrigin={artboardOrigin} />
      <div className={styles.pageInfo}>
        {renaming ? (
          <RenameForm
            label="Nom de la page"
            value={page.title}
            size="page"
            saveLabel="OK"
            onSave={async (title) => {
              await onRename(title);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <div className={styles.pageTitleRow}>
            <a href={routeHref({ name: "page", pageId: page.id })} className={cx(styles.pageTitle, styles.pageTitleLink)}>
              {page.title}
            </a>
            {!readOnly && <RenamePencil label="Renommer la page" size="page" onClick={() => setRenaming(true)} />}
            {!readOnly && <PageArchiveButton pageId={page.id} onArchived={onArchived} />}
            <span className={styles.spacer} />
            {!readOnly && stats && stats.openThreads > 0 && (
              <StatusBadge tone="warning" className={styles.chip}>
                {counted(stats.openThreads, "fil", "fils")}
              </StatusBadge>
            )}
          </div>
        )}
        <div className={styles.pageMeta}>
          {count}
          {modified}
        </div>
      </div>
    </div>
  );
}

function DesignSystemBox({ projectId, detail, readOnly }: { projectId: string; detail: ProjectDesignSystem; readOnly: boolean }) {
  const swatches = previewSwatches(detail);
  const components = projectComponentCountLabel(detail.components.length);
  return (
    <section className={styles.panelSection}>
      <div className={styles.panelHeading}>
        <h2 className={styles.panelTitle}>Design system</h2>
        <span className={styles.spacer} />
        {!readOnly && <a href={routeHref({ name: "projectDesignSystem", projectId })}>Modifier</a>}
      </div>
      <a href={routeHref({ name: "projectDesignSystem", projectId })} className={styles.dsCard}>
        <div aria-hidden="true" className={styles.dsPreview}>
          {swatches.map((swatch, index) => (
            <div
              key={index}
              className={cx(styles.dsSwatch, swatch.overridden && styles.dsSwatchOverridden, swatch.bordered && styles.dsSwatchBordered)}
              style={{ background: swatch.value }}
            />
          ))}
          <div className={styles.dsAa}>Aa</div>
        </div>
        <div className={styles.dsInfo}>
          {detail.designSystem && detail.diffusion ? (
            <>
              <div className={styles.dsNameRow}>
                <span className={styles.dsName}>{detail.designSystem.title}</span>
                <span className={styles.dsDiffusion}>diffusion {detail.diffusion.number}</span>
              </div>
              <div className={styles.dsPills}>
                <span className={styles.dsPillWarning}>{overrideCountLabel(detail.overrideCount)}</span>
                <span className={styles.dsPillNeutral}>{components}</span>
              </div>
            </>
          ) : (
            <>
              <span className={styles.dsName}>Aucun : style propre au projet</span>
              <span className={styles.dsMeta}>Pas de design system partagé · {components}</span>
            </>
          )}
        </div>
      </a>
    </section>
  );
}

function AssetTile({ asset, previewUrl }: { asset: AssetEntry; previewUrl: string | null }) {
  let preview: ReactNode;
  if (asset.kind === "folder") {
    preview = asset.fonts ? (
      <span className={styles.assetFonts}>Aa</span>
    ) : (
      <span className={styles.assetShapes}>
        <span className={styles.shapeRound} />
        <span className={styles.shapeSquare} />
        <span className={styles.shapeTab} />
        <span className={styles.shapeDrop} />
      </span>
    );
  } else if (previewUrl && IMAGE_EXTENSION.test(asset.name)) {
    preview = <img src={previewUrl} alt="" className={styles.assetImage} />;
  } else {
    preview = <span className={styles.assetGlyph}>{asset.name.split(".").pop()}</span>;
  }
  return (
    <div className={styles.asset}>
      <div className={styles.assetPreview} aria-hidden="true">
        {preview}
      </div>
      <div className={styles.assetName}>{asset.kind === "folder" ? `${asset.name}/ · ${asset.count}` : asset.name}</div>
    </div>
  );
}

type AssetEntry = { kind: "file"; name: string } | { kind: "folder"; name: string; count: number; fonts: boolean };

function groupAssets(assets: ProjectAsset[]): AssetEntry[] {
  const entries: AssetEntry[] = [];
  const folders = new Map<string, ProjectAsset[]>();
  for (const asset of assets) {
    const [first, ...rest] = asset.name.split("/");
    if (rest.length === 0) {
      entries.push({ kind: "file", name: asset.name });
    } else {
      folders.set(first!, [...(folders.get(first!) ?? []), asset]);
    }
  }
  for (const [name, files] of folders) {
    entries.push({ kind: "folder", name, count: files.length, fonts: files.every((file) => FONT_EXTENSION.test(file.name)) });
  }
  return entries;
}

export function ProjectOverview({ projectId }: { projectId: string }) {
  const who = useWho();
  const [project, setProject] = useState<Project | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [archivedPages, setArchivedPages] = useState<Page[]>([]);
  const [showArchivedPages, setShowArchivedPages] = useState(false);
  const [pageStats, setPageStats] = useState<Record<string, PageStats>>({});
  const [artboardOrigin, setArtboardOrigin] = useState("");
  const [designSystem, setDesignSystem] = useState<ProjectDesignSystem | null>(null);
  const [designMd, setDesignMd] = useState<string | null>(null);
  const [designMdInfo, setDesignMdInfo] = useState<DesignMdInfo | null>(null);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [creating, setCreating] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [reload, setReload] = useState(0);

  const loadAssets = () =>
    fetch(`/api/projects/${projectId}/assets`)
      .then((res) => res.json() as Promise<ProjectAsset[]>)
      .then(setAssets);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json() as Promise<{ artboardOrigin: string }>)
      .then((config) => setArtboardOrigin(config.artboardOrigin));
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json() as Promise<Project>)
      .then(setProject);
    fetch(`/api/projects/${projectId}/design-system`).then(async (res) => setDesignSystem(res.ok ? ((await res.json()) as ProjectDesignSystem) : null));
    fetch(`/api/projects/${projectId}/pages`)
      .then((res) => res.json() as Promise<Page[]>)
      .then(async (loaded) => {
        setPages(loaded);
        const entries = await Promise.all(
          loaded.map(async (page): Promise<[string, PageStats]> => {
            const [threads, versions] = await Promise.all([
              fetch(`/api/pages/${page.id}/threads`).then((res) => res.json() as Promise<Thread[]>),
              fetch(`/api/pages/${page.id}/versions`).then((res) => res.json() as Promise<PageVersionSummary[]>),
            ]);
            return [
              page.id,
              {
                openThreads: threads.filter((thread) => thread.status === "open").length,
                threads: threads.length,
                versions: versions.length,
                updatedAt: versions[0]?.createdAt ?? null,
              },
            ];
          }),
        );
        setPageStats(Object.fromEntries(entries));
      });
    fetch(`/api/projects/${projectId}/pages?archived=1`)
      .then((res) => res.json() as Promise<Page[]>)
      .then(setArchivedPages);
    fetch(`/api/projects/${projectId}/design-md`)
      .then((res) => res.json() as Promise<DesignMdResponse>)
      .then(({ content }) => setDesignMd(content));
    fetch(`/api/projects/${projectId}/design-md/info`)
      .then((res) => res.json() as Promise<DesignMdInfo>)
      .then(setDesignMdInfo);
    void loadAssets();
  }, [projectId, reload]);

  if (!project) return <PageContent>Chargement…</PageContent>;

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of files) {
      await fetch(`/api/projects/${projectId}/assets/${file.name.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
    }
    await loadAssets();
  }

  async function renameProject(title: string) {
    const res = await fetch(`/api/projects/${projectId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error(`Rename refused (${res.status})`);
    setProject({ ...project!, title });
  }

  async function renamePage(pageId: string, title: string) {
    const res = await fetch(`/api/pages/${pageId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error(`Rename refused (${res.status})`);
    setPages((current) => current.map((page) => (page.id === pageId ? { ...page, title } : page)));
  }

  const archivedAt = project.archivedAt;
  const readOnly = archivedAt !== undefined;
  const allStats = Object.values(pageStats);
  const openThreads = allStats.reduce((sum, stats) => sum + stats.openThreads, 0);
  const threadCount = allStats.reduce((sum, stats) => sum + stats.threads, 0);
  const versionCount = allStats.reduce((sum, stats) => sum + stats.versions, 0);
  const summary = readOnly
    ? `${counted(pages.length, "page", "pages")} · ${counted(threadCount, "fil", "fils")} · ${counted(versionCount, "version", "versions")}`
    : `${counted(pages.length, "page", "pages")} · ${counted(openThreads, "fil ouvert", "fils ouverts")}`;
  const assetPreviewPage = pages[0];
  const assetEntries = groupAssets(assets);

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <a href={routeHref({ name: "home" })} aria-label="Accueil" className={styles.logoLink}>
          <Logo />
        </a>
        <nav aria-label="Fil d'Ariane" className={styles.breadcrumb}>
          <a href={routeHref({ name: "projects" })}>Projets</a>
          <span aria-hidden="true">/</span>
          {readOnly && (
            <>
              <a href={routeHref({ name: "archivedProjects" })}>Archivés</a>
              <span aria-hidden="true">/</span>
            </>
          )}
          <span className={styles.current}>{project.title}</span>
        </nav>
        <div className={styles.spacer} />
        {!readOnly && (
          <>
            <AgentPill project={project} onProjectChange={setProject} />
            <Button variant="accent" onClick={() => setCreating(true)}>
              Nouvelle page
            </Button>
          </>
        )}
      </header>
      {archivedAt && <ArchivedBanner kind="project" id={projectId} archivedAt={archivedAt} onUnarchived={() => setReload((count) => count + 1)} />}

      <div className={styles.body}>
      <PageContent className={styles.main}>
        <div className={styles.heading}>
          {renamingProject ? (
            <RenameForm
              label="Nom du projet"
              value={project.title}
              size="project"
              saveLabel="Renommer"
              onSave={async (title) => {
                await renameProject(title);
                setRenamingProject(false);
              }}
              onCancel={() => setRenamingProject(false)}
            />
          ) : (
            <div className={cx(styles.titleRow, renameHost)}>
              <h1 className={styles.title}>{project.title}</h1>
              {!readOnly && <RenamePencil label="Renommer le projet" size="project" onClick={() => setRenamingProject(true)} />}
            </div>
          )}
          <div className={styles.summary}>
            {project.agent && !readOnly ? `Agent ${folderName(project.agent.folder)} · ${project.agent.folder} · ${summary}` : summary}
          </div>
        </div>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Pages</h2>
          <div className={styles.pageGrid}>
            {pages.map((page, index) => (
              <PageCard
                key={page.id}
                page={page}
                stats={pageStats[page.id]}
                artboardOrigin={artboardOrigin}
                current={index === 0 && !readOnly}
                readOnly={readOnly}
                onRename={(title) => renamePage(page.id, title)}
                onArchived={() => setReload((count) => count + 1)}
              />
            ))}
            {!readOnly && (
              <button type="button" className={styles.newPageTile} onClick={() => setCreating(true)}>
                <span aria-hidden="true" className={styles.plus}>
                  +
                </span>
                <span className={styles.newPageTitle}>Nouvelle page</span>
                <span className={styles.newPageHint}>vide, ou décrite à Claude</span>
              </button>
            )}
          </div>
          {archivedPages.length > 0 && (
            <>
              <button type="button" aria-expanded={showArchivedPages} className={styles.archivedToggle} onClick={() => setShowArchivedPages(!showArchivedPages)}>
                <ArchiveIcon size={16} />
                Pages archivées · {archivedPages.length}
                <span aria-hidden="true" className={cx(styles.archivedChevron, showArchivedPages && styles.archivedChevronOpen)}>
                  ›
                </span>
              </button>
              {showArchivedPages && (
                <div className={styles.pageGrid}>
                  {archivedPages.map((page) => (
                    <PageCard key={page.id} page={page} stats={undefined} artboardOrigin={artboardOrigin} current={false} readOnly onRename={async () => {}} onArchived={() => {}} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.assetsHeader}>
            <h2 className={styles.sectionTitle}>Assets du projet</h2>
            <span className={styles.assetsPath}>assets/ · partagés par tous les artefacts</span>
            <span className={styles.spacer} />
            {!readOnly && (
              <>
                <Button size="sm" onClick={() => uploadInput.current?.click()}>
                  Ajouter
                </Button>
                <input ref={uploadInput} type="file" multiple hidden onChange={upload} aria-label="Ajouter des assets" />
              </>
            )}
          </div>
          {assetEntries.length === 0 ? (
            <p className={styles.empty}>Aucun asset pour l'instant.</p>
          ) : (
            <div className={styles.assetGrid}>
              {assetEntries.map((asset) => (
                <AssetTile
                  key={`${asset.kind}:${asset.name}`}
                  asset={asset}
                  previewUrl={
                    assetPreviewPage && artboardOrigin
                      ? `${artboardOrigin}/pages/${assetPreviewPage.id}/assets/${asset.name.split("/").map(encodeURIComponent).join("/")}`
                      : null
                  }
                />
              ))}
            </div>
          )}
        </section>

        {readOnly ? (
          <DeleteSection
            kind="project"
            id={projectId}
            title={project.title}
            summary="Ses pages, fils, versions, conversations et assets sont effacés. Impossible de revenir en arrière."
            contents={`Ses ${counted(pages.length, "page", "pages")}, ${counted(threadCount, "fil", "fils")}, ${counted(versionCount, "version", "versions")}, ses conversations et ses assets`}
            onDeleted={() => navigateTo({ name: "archivedProjects" }, "replace")}
          />
        ) : (
          <ArchiveFooter kind="project" id={projectId} title={project.title} onArchived={() => setReload((count) => count + 1)} />
        )}
      </PageContent>

      <SidePanel label="Contexte du projet" width={380} className={styles.aside}>
        <SidePanelBody className={styles.panelBody}>
          {designSystem && <DesignSystemBox projectId={projectId} detail={designSystem} readOnly={readOnly} />}

          <section className={cx(styles.panelSection, styles.grow)}>
            <div className={styles.panelHeading}>
              <h2 className={styles.designMdTitle}>DESIGN.md</h2>
              <span className={styles.spacer} />
              {!readOnly && (
                <a href={routeHref({ name: "designMd", projectId })} aria-label="Modifier DESIGN.md">
                  Modifier
                </a>
              )}
            </div>
            {designMd !== null && designMd.trim() !== "" ? (
              <MarkdownPreview source={designMd} />
            ) : (
              <p className={styles.empty}>Aucune consigne pour l'instant.</p>
            )}
            {designMdInfo?.lastModified && (
              <div data-testid="design-md-last-modified" className={styles.designMdMeta}>
                {designMdStatus(designMdInfo.lastModified.origin, designMdInfo.lastModified.originLabel, dayLabel(designMdInfo.lastModified.createdAt), who(designMdInfo.lastModified.person))}
              </div>
            )}
          </section>
        </SidePanelBody>
      </SidePanel>
      </div>

      {creating && (
        <NewPageDialog
          projectId={projectId}
          projectTitle={project.title}
          designSystem={project.designSystem}
          onClose={() => setCreating(false)}
          onCreated={(page) => {
            window.location.hash = routeHref({ name: "page", pageId: page.id });
          }}
        />
      )}
    </div>
  );
}
