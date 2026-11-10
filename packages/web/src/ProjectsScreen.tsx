import { useEffect, useState, type FormEvent } from "react";
import {
  type HomeProject,
  type CreateProjectRequest,
  type ProjectVisibility,
  type DesignSystemSummary,
  type Page,
  type Project,
  type Thread,
} from "@redline/shared";
import { ArchiveIcon, archivedOnLabel } from "./ArchiveControls.js";
import { agentLabel } from "./agentLabel.js";
import { Dialog } from "./Dialog.js";
import { ProjectPreview } from "./ProjectPreview.js";
import { routeHref } from "./router.js";
import { useHome } from "./useHome.js";
import { useMe } from "./useMe.js";
import { VISIBILITY_LABEL, VisibilityBadge } from "./VisibilityBadge.js";
import { Button, DialogActions, Field, PageContent, StatusBadge, TextInput, Textarea, cx } from "./ui/index.js";
import styles from "./ProjectsScreen.module.css";

const NO_DESIGN_SYSTEM = "";
const DAY_MS = 86_400_000;

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

function modifiedLabel(iso: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "Modifié à l'instant";
  if (minutes < 60) return `Modifié il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Modifié il y a ${hours} h`;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "Modifié hier" : `Modifié il y a ${days} jours`;
}

function agentSummary(project: Project): { online: boolean; text: string } {
  if (project.servedBy?.kind === "global") return { online: true, text: "Agent global" };
  if (project.servedBy) return { online: true, text: `Agent ${folderName(project.servedBy.folder)}` };
  if (project.agent) return { online: false, text: `Agent ${folderName(project.agent.folder)}, hors ligne` };
  return { online: false, text: "Aucun agent" };
}

function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}` : (names[0] ?? "");
}

function designSystemUse(designSystem: DesignSystemSummary): string {
  return designSystem.usedBy.length === 0
    ? "Pas encore utilisé"
    : `Déjà utilisé par ${joinNames(designSystem.usedBy.map((project) => project.title))}`;
}

const VISIBILITY_OPTIONS: { value: ProjectVisibility; description: string }[] = [
  { value: "team", description: "Tous les membres le voient et y travaillent." },
  { value: "private", description: "Toi et les admins seulement ; tu ajoutes des membres ensuite." },
];

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [visibility, setVisibility] = useState<ProjectVisibility>("team");
  const hasAccounts = useMe()?.account !== undefined;

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  const selected = choice ?? designSystems[0]?.id ?? NO_DESIGN_SYSTEM;
  const canCreate = title.trim() !== "";
  const options = [
    ...designSystems.map((ds) => ({ id: ds.id, title: ds.title, description: designSystemUse(ds) })),
    { id: NO_DESIGN_SYSTEM, title: "Aucun pour l'instant", description: "Claude crée un style d'après le sujet du projet" },
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    const body: CreateProjectRequest = {
      title: title.trim(),
      instructions: instructions.trim(),
      designSystem: selected || null,
      ...(hasAccounts && { visibility }),
    };
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    onCreated((await res.json()) as Project);
  }

  return (
    <Dialog title="Nouveau projet" onClose={onClose}>
      <div className={styles.advice}>
        <div className={styles.adviceTitle}>Conseillé : partir d'un dossier de code</div>
        <div className={styles.adviceText}>
          Lance la commande dans le dossier de ton projet : elle te propose de le lier à un projet existant ou d'en créer
          un, puis démarre son agent de projet. Les sessions ont son CLAUDE.md, son code et ses MCP.
        </div>
        <code className={styles.command}>cd ~/projets/mon-projet &amp;&amp; redline agent</code>
      </div>

      <div className={styles.divider}>ou crée-le directement ici</div>

      <form onSubmit={submit} className={styles.form}>
        <Field label="Titre">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Site vitrine du cabinet" />
        </Field>
        {hasAccounts && (
          <div role="radiogroup" aria-labelledby="new-project-visibility" className={styles.options}>
            <div id="new-project-visibility" className={styles.optionsLabel}>
              Visibilité
            </div>
            {VISIBILITY_OPTIONS.map((option) => (
              <label key={option.value} className={cx(styles.choice, option.value === visibility && styles.choiceOn)}>
                <input type="radio" name="new-project-visibility" checked={option.value === visibility} onChange={() => setVisibility(option.value)} />
                <span className={styles.choiceText}>
                  <strong>{VISIBILITY_LABEL[option.value]}</strong>
                  <span>{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <Field
          label="Instructions pour Claude"
          optional
          hint="Si tu en donnes, ce sera le premier message de la première conversation du projet."
        >
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            placeholder="Décris le projet, la cible, ce que tu veux voir en premier…"
          />
        </Field>
        <div role="radiogroup" aria-labelledby="new-project-design-system" className={styles.options}>
          <div id="new-project-design-system" className={styles.optionsLabel}>
            Design system
          </div>
          {options.map((option) => (
            <label key={option.id} className={cx(styles.option, option.id === selected && styles.optionSelected)}>
              <input
                type="radio"
                name="new-project-design-system"
                checked={option.id === selected}
                onChange={() => setChoice(option.id)}
              />
              <span className={styles.optionText}>
                <span className={styles.optionTitle}>{option.title}</span>
                <span className={styles.optionDescription}>{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        <DialogActions>
          <Button onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" variant="accent" aria-disabled={!canCreate} className={styles.create}>
            Créer le projet
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function ProjectCard({
  project,
  activity,
  designSystemTitle,
}: {
  project: Project;
  activity: HomeProject | undefined;
  designSystemTitle: string | undefined;
}) {
  const agent = agentSummary(project);
  const hasAccounts = useMe()?.account !== undefined;
  const details = [
    agent.text,
    plural(activity?.pageCount ?? 0, "page", "pages"),
    designSystemTitle ?? "sans DS",
    ...(hasAccounts && project.createdBy ? [`créé par ${project.createdBy.name}`] : []),
  ].join(" · ");
  return (
    <a href={routeHref({ name: "project", projectId: project.id })} className={styles.card}>
      <ProjectPreview pageId={activity?.lastPageId} height={190} />
      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <span className={styles.cardTitle}>{project.title}</span>
          <span className={styles.cardBadges}>
            {hasAccounts && <VisibilityBadge visibility={project.visibility} />}
            {activity && activity.waitingThreads > 0 && activity.waitingThreads >= activity.openThreads ? (
              <StatusBadge tone="neutral" size="sm" className={styles.cardBadge}>
                {plural(activity.waitingThreads, "fil en attente", "fils en attente")}
              </StatusBadge>
            ) : activity && activity.openThreads > 0 ? (
              <StatusBadge tone="warning" size="sm" className={styles.cardBadge}>
                {plural(activity.openThreads, "fil ouvert", "fils ouverts")}
              </StatusBadge>
            ) : null}
          </span>
        </div>
        <div className={styles.agentLine} title={agentLabel(project)}>
          <span aria-hidden="true" className={cx(styles.dot, agent.online ? styles.dotOnline : styles.dotOffline)} />
          <span data-testid="project-agent">{details}</span>
        </div>
        {activity?.updatedAt && <div className={styles.modified}>{modifiedLabel(activity.updatedAt)}</div>}
      </div>
    </a>
  );
}

/** "6 projets · 1 privé": the project list's header line, drawn on the artboard `projet`. */
export function projectsSummary(projects: Project[]): string {
  const privateCount = projects.filter((project) => project.visibility === "private").length;
  return [plural(projects.length, "projet", "projets"), ...(privateCount > 0 ? [plural(privateCount, "privé", "privés")] : [])].join(" · ");
}

export function ProjectsScreen() {
  const hasAccounts = useMe()?.account !== undefined;
  const [projects, setProjects] = useState<Project[] | null>(null);
  const { home } = useHome();
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [archivedCount, setArchivedCount] = useState(0);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json() as Promise<Project[]>)
      .then(setProjects);
    fetch("/api/projects?archived=1")
      .then((res) => res.json() as Promise<Project[]>)
      .then((archived) => setArchivedCount(archived.length));
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  const query = search.trim().toLowerCase();
  const visible = (projects ?? []).filter((project) => project.title.toLowerCase().includes(query));

  return (
    <PageContent>
      <div className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>Projets</h1>
          {hasAccounts && projects && (
            <p className={styles.meta} data-testid="projects-summary">
              {projectsSummary(projects)}
            </p>
          )}
        </div>
        <TextInput
          type="search"
          size="md"
          aria-label="Rechercher un projet"
          placeholder="Rechercher un projet…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={styles.search}
        />
        <Button variant="accent" size="lg" className={styles.action} onClick={() => setCreating(true)}>
          Nouveau projet
        </Button>
      </div>
      {projects && (
        <div className={styles.grid}>
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              activity={home?.projects.find((p) => p.id === project.id)}
              designSystemTitle={designSystems.find((ds) => ds.id === project.designSystem)?.title}
            />
          ))}
          <button type="button" className={styles.newTile} onClick={() => setCreating(true)}>
            <span aria-hidden="true" className={styles.newTilePlus}>
              +
            </span>
            <span className={styles.newTileTitle}>Nouveau projet</span>
            <span className={styles.newTileHint}>depuis un dossier de code, ou ici</span>
          </button>
        </div>
      )}
      {archivedCount > 0 && (
        <a href={routeHref({ name: "archivedProjects" })} className={styles.archivedLink}>
          <ArchiveIcon size={16} />
          Projets archivés · {archivedCount}
          <span aria-hidden="true" className={styles.archivedChevron}>
            ›
          </span>
        </a>
      )}
      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            window.location.hash = routeHref({ name: "project", projectId: project.id });
          }}
        />
      )}
    </PageContent>
  );
}

interface ArchivedStats {
  pageCount: number;
  threadCount: number;
  firstPageId?: string;
}

function ArchivedProjectCard({ project, stats, designSystemTitle }: { project: Project; stats: ArchivedStats | undefined; designSystemTitle: string | undefined }) {
  const details = [plural(stats?.pageCount ?? 0, "page", "pages"), plural(stats?.threadCount ?? 0, "fil", "fils"), designSystemTitle ?? "sans DS"].join(" · ");
  return (
    <a href={routeHref({ name: "project", projectId: project.id })} className={styles.card}>
      <div className={styles.archivedPreview}>
        <ProjectPreview pageId={stats?.firstPageId} height={190} />
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <span className={styles.cardTitle}>{project.title}</span>
          <span className={styles.archivedPill}>Archivé</span>
        </div>
        <div className={styles.archivedDetails}>{details}</div>
        {project.archivedAt && <div className={styles.modified}>{archivedOnLabel(project.archivedAt)}</div>}
      </div>
    </a>
  );
}

/** "Projets archivés": read-only projects, each opened to be unarchived or deleted for good. */
export function ArchivedProjectsScreen() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [stats, setStats] = useState<Record<string, ArchivedStats>>({});
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/projects?archived=1")
      .then((res) => res.json() as Promise<Project[]>)
      .then(async (archived) => {
        setProjects(archived);
        const entries = await Promise.all(
          archived.map(async (project): Promise<[string, ArchivedStats]> => {
            const pages = (await (await fetch(`/api/projects/${project.id}/pages`)).json()) as Page[];
            const threads = await Promise.all(pages.map(async (page) => ((await (await fetch(`/api/pages/${page.id}/threads`)).json()) as Thread[]).length));
            return [project.id, { pageCount: pages.length, threadCount: threads.reduce((sum, count) => sum + count, 0), firstPageId: pages[0]?.id }];
          }),
        );
        setStats(Object.fromEntries(entries));
      });
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  const query = search.trim().toLowerCase();
  const visible = (projects ?? []).filter((project) => project.title.toLowerCase().includes(query));

  return (
    <PageContent>
      <div className={styles.archivedHeading}>
        <nav aria-label="Fil d'Ariane" className={styles.archivedBreadcrumb}>
          <a href={routeHref({ name: "projects" })}>Projets</a>
          <span aria-hidden="true">/</span>
          <span className={styles.archivedCurrent}>Archivés</span>
        </nav>
        <div className={styles.header}>
          <h1 className={styles.title}>Projets archivés</h1>
          <TextInput
            type="search"
            size="md"
            aria-label="Rechercher un projet archivé"
            placeholder="Rechercher un projet archivé…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={styles.archivedSearch}
          />
        </div>
        <p className={styles.archivedIntro}>En lecture seule. Ouvre un projet pour le désarchiver ou le supprimer définitivement.</p>
      </div>
      {projects && (
        <div className={styles.grid}>
          {visible.map((project) => (
            <ArchivedProjectCard
              key={project.id}
              project={project}
              stats={stats[project.id]}
              designSystemTitle={designSystems.find((ds) => ds.id === project.designSystem)?.title}
            />
          ))}
        </div>
      )}
    </PageContent>
  );
}
