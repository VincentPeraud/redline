import { useEffect, useState, type FormEvent } from "react";
import {
  NEUTRAL_DESIGN_SYSTEM_ID,
  type HomeProject,
  type CreateProjectRequest,
  type DesignSystemSummary,
  type Project,
} from "@redline/shared";
import { agentLabel } from "./agentLabel.js";
import { Dialog } from "./Dialog.js";
import { ProjectThumb } from "./ProjectThumb.js";
import { routeHref } from "./router.js";
import { useHome } from "./useHome.js";
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

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  const choosable = designSystems.filter((ds) => ds.id !== NEUTRAL_DESIGN_SYSTEM_ID);
  const selected = choice ?? choosable[0]?.id ?? NO_DESIGN_SYSTEM;
  const canCreate = title.trim() !== "";
  const options = [
    ...choosable.map((ds) => ({ id: ds.id, title: ds.title, description: designSystemUse(ds) })),
    { id: NO_DESIGN_SYSTEM, title: "Aucun pour l'instant", description: "Claude part d'un style neutre" },
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    const body: CreateProjectRequest = {
      title: title.trim(),
      instructions: instructions.trim(),
      designSystem: selected || null,
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
          <Button size="lg" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" variant="accent" size="lg" aria-disabled={!canCreate} className={styles.create}>
            Créer le projet
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function ProjectCard({
  project,
  position,
  activity,
  designSystemTitle,
}: {
  project: Project;
  position: number;
  activity: HomeProject | undefined;
  designSystemTitle: string | undefined;
}) {
  const agent = agentSummary(project);
  const details = [agent.text, plural(activity?.pageCount ?? 0, "page", "pages"), designSystemTitle ?? "sans DS"].join(" · ");
  return (
    <a href={routeHref({ name: "project", projectId: project.id })} className={styles.card}>
      <ProjectThumb position={position} />
      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <span className={styles.cardTitle}>{project.title}</span>
          {activity && activity.waitingThreads > 0 ? (
            <StatusBadge tone="neutral" size="sm" className={styles.cardBadge}>
              {plural(activity.waitingThreads, "fil en attente", "fils en attente")}
            </StatusBadge>
          ) : activity && activity.openThreads > 0 ? (
            <StatusBadge tone="warning" size="sm" className={styles.cardBadge}>
              {plural(activity.openThreads, "fil ouvert", "fils ouverts")}
            </StatusBadge>
          ) : null}
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

export function ProjectsScreen() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const { home } = useHome();
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json() as Promise<Project[]>)
      .then(setProjects);
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  const query = search.trim().toLowerCase();
  const visible = (projects ?? []).filter((project) => project.title.toLowerCase().includes(query));

  return (
    <PageContent>
      <div className={styles.header}>
        <h1 className={styles.title}>Projets</h1>
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
          {visible.map((project, position) => (
            <ProjectCard
              key={project.id}
              project={project}
              position={position}
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
