import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  NEUTRAL_DESIGN_SYSTEM_ID,
  type DesignMdInfo,
  type DesignMdResponse,
  type DesignSystemSummary,
  type Page,
  type PageVersionSummary,
  type Project,
  type ProjectAsset,
  type Thread,
} from "@redline/shared";
import { AgentPill } from "./AgentPill.js";
import { dayLabel, designMdAuthor } from "./historyLabels.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { NewPageDialog } from "./NewPageDialog.js";
import { PageThumbnail, usePageArtboards } from "./PageThumbnail.js";
import { relativeTime } from "./relativeTime.js";
import { RenameForm, RenamePencil, renameHost } from "./Rename.js";
import { routeHref } from "./router.js";
import { Button, Logo, PageContent, SidePanel, SidePanelBody, StatusBadge, cx } from "./ui/index.js";
import styles from "./ProjectOverview.module.css";

interface PageStats {
  openThreads: number;
  updatedAt: string | null;
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const FONT_EXTENSION = /\.(woff2?|ttf|otf)$/i;

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function PageCard({
  page,
  stats,
  artboardOrigin,
  current,
  onRename,
}: {
  page: Page;
  stats: PageStats | undefined;
  artboardOrigin: string;
  current: boolean;
  onRename: (title: string) => Promise<void>;
}) {
  const artboards = usePageArtboards(page.id, page.version.files);
  const [renaming, setRenaming] = useState(false);
  const count = plural(artboards?.length ?? 0, "artboard", "artboards");
  const modified = stats?.updatedAt ? ` · modifié ${relativeTime(stats.updatedAt)}` : "";

  return (
    <div data-testid="page-card" className={cx(styles.pageCard, renameHost, current && styles.pageCardCurrent)}>
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
            <RenamePencil label="Renommer la page" size="page" onClick={() => setRenaming(true)} />
            <span className={styles.spacer} />
            {stats && stats.openThreads > 0 && (
              <StatusBadge tone="warning" className={styles.chip}>
                {plural(stats.openThreads, "fil", "fils")}
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

function DesignSystemCard({
  designSystem,
  pageCount,
  artboardOrigin,
}: {
  designSystem: DesignSystemSummary;
  pageCount: number;
  artboardOrigin: string;
}) {
  const [page, setPage] = useState<Page | null>(null);

  useEffect(() => {
    fetch(`/api/pages/${designSystem.pageId}`)
      .then((res) => res.json() as Promise<Page>)
      .then(setPage);
  }, [designSystem.pageId]);

  return (
    <a href={routeHref({ name: "designSystems" })} className={styles.dsCard}>
      {page ? (
        <DesignSystemPreview page={page} artboardOrigin={artboardOrigin} />
      ) : (
        <div className={styles.dsPlaceholder} />
      )}
      <div className={styles.pageInfo}>
        <div className={styles.pageTitleRow}>
          <span className={styles.pageTitle}>{designSystem.title}</span>
        </div>
        <div className={styles.pageMeta}>{pageCount === 1 ? "Utilisé par la page du projet" : `Utilisé par les ${pageCount} pages du projet`}</div>
      </div>
    </a>
  );
}

function DesignSystemPreview({ page, artboardOrigin }: { page: Page; artboardOrigin: string }) {
  const artboards = usePageArtboards(page.id, page.version.files);
  return <PageThumbnail pageId={page.id} artboards={artboards?.slice(0, 1) ?? null} artboardOrigin={artboardOrigin} />;
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
  const [project, setProject] = useState<Project | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageStats, setPageStats] = useState<Record<string, PageStats>>({});
  const [artboardOrigin, setArtboardOrigin] = useState("");
  const [designSystem, setDesignSystem] = useState<DesignSystemSummary | null>(null);
  const [designMd, setDesignMd] = useState<string | null>(null);
  const [designMdInfo, setDesignMdInfo] = useState<DesignMdInfo | null>(null);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [creating, setCreating] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);

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
      .then(async (loaded) => {
        setProject(loaded);
        const systems = (await (await fetch("/api/design-systems")).json()) as DesignSystemSummary[];
        const id = loaded.designSystem ?? NEUTRAL_DESIGN_SYSTEM_ID;
        setDesignSystem(systems.find((system) => system.id === id) ?? null);
      });
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
              { openThreads: threads.filter((thread) => thread.status === "open").length, updatedAt: versions[0]?.createdAt ?? null },
            ];
          }),
        );
        setPageStats(Object.fromEntries(entries));
      });
    fetch(`/api/projects/${projectId}/design-md`)
      .then((res) => res.json() as Promise<DesignMdResponse>)
      .then(({ content }) => setDesignMd(content));
    fetch(`/api/projects/${projectId}/design-md/info`)
      .then((res) => res.json() as Promise<DesignMdInfo>)
      .then(setDesignMdInfo);
    void loadAssets();
  }, [projectId]);

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

  const openThreads = Object.values(pageStats).reduce((sum, stats) => sum + stats.openThreads, 0);
  const summary = `${plural(pages.length, "page", "pages")} · ${plural(openThreads, "fil ouvert", "fils ouverts")}`;
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
          <span className={styles.current}>{project.title}</span>
        </nav>
        <div className={styles.spacer} />
        <AgentPill project={project} onProjectChange={setProject} />
        <Button variant="accent" onClick={() => setCreating(true)}>
          Nouvelle page
        </Button>
      </header>

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
              <RenamePencil label="Renommer le projet" size="project" onClick={() => setRenamingProject(true)} />
            </div>
          )}
          <div className={styles.summary}>
            {project.agent ? `Agent ${folderName(project.agent.folder)} · ${project.agent.folder} · ${summary}` : summary}
          </div>
        </div>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Pages</h2>
          <div className={styles.pageGrid}>
            {pages.map((page, index) => (
              <PageCard key={page.id} page={page} stats={pageStats[page.id]} artboardOrigin={artboardOrigin} current={index === 0} onRename={(title) => renamePage(page.id, title)} />
            ))}
            <button type="button" className={styles.newPageTile} onClick={() => setCreating(true)}>
              <span aria-hidden="true" className={styles.plus}>
                +
              </span>
              <span className={styles.newPageTitle}>Nouvelle page</span>
              <span className={styles.newPageHint}>vide, ou décrite à Claude</span>
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.assetsHeader}>
            <h2 className={styles.sectionTitle}>Assets du projet</h2>
            <span className={styles.assetsPath}>assets/ · partagés par tous les artefacts</span>
            <span className={styles.spacer} />
            <Button size="sm" onClick={() => uploadInput.current?.click()}>
              Ajouter
            </Button>
            <input ref={uploadInput} type="file" multiple hidden onChange={upload} aria-label="Ajouter des assets" />
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
      </PageContent>

      <SidePanel label="Contexte du projet" width={380} className={styles.aside}>
        <SidePanelBody className={styles.panelBody}>
          {designSystem && (
            <section className={styles.panelSection}>
              <div className={styles.panelHeading}>
                <h2 className={styles.panelTitle}>Design system</h2>
                <span className={styles.spacer} />
                <a href={routeHref({ name: "designSystems" })}>Ouvrir</a>
              </div>
              <DesignSystemCard designSystem={designSystem} pageCount={pages.length} artboardOrigin={artboardOrigin} />
            </section>
          )}

          <section className={cx(styles.panelSection, styles.grow)}>
            <div className={styles.panelHeading}>
              <h2 className={styles.designMdTitle}>DESIGN.md</h2>
              <span className={styles.spacer} />
              <a href={routeHref({ name: "designMd", projectId })} aria-label="Modifier DESIGN.md">
                Modifier
              </a>
            </div>
            {designMd !== null && designMd.trim() !== "" ? (
              <MarkdownPreview source={designMd} />
            ) : (
              <p className={styles.empty}>Aucune consigne pour l'instant.</p>
            )}
            {designMdInfo?.lastModified && (
              <div data-testid="design-md-last-modified" className={styles.designMdMeta}>
                Dernière modification par {designMdAuthor(designMdInfo.lastModified.origin, designMdInfo.lastModified.originLabel)} · {dayLabel(designMdInfo.lastModified.createdAt)}
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
