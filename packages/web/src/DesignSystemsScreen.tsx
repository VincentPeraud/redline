import { useEffect, useState, type FormEvent } from "react";
import {
  type CreateDesignSystemRequest,
  type DesignSystem,
  type DesignSystemSummary,
  NEUTRAL_DESIGN_SYSTEM_ID,
  type Project,
} from "@redline/shared";
import { Button, Dialog, DialogActions, Field, PageContent, PageHeader, Select, Textarea, TextInput } from "./ui/index.js";
import { usedByLabel } from "./designSystemLabel.js";
import { relativeTime } from "./relativeTime.js";
import { routeHref } from "./router.js";
import styles from "./DesignSystemsScreen.module.css";

function NewDesignSystemDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (designSystem: DesignSystem) => void }) {
  const [title, setTitle] = useState("");
  const [fromProjectId, setFromProjectId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json() as Promise<Project[]>)
      .then(setProjects);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: CreateDesignSystemRequest = {
      title: title.trim(),
      ...(fromProjectId ? { fromProjectId } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    };
    const res = await fetch("/api/design-systems", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    onCreated((await res.json()) as DesignSystem);
  }

  return (
    <Dialog title="Ajouter un design system" onClose={onClose}>
      <p className={styles.intro}>
        Le design system est créé avec le socle de variables commun (<span className={styles.mono}>--color-primary</span>,{" "}
        <span className={styles.mono}>--font-heading</span>…), que Claude remplit. Tu peux lui demander de s'inspirer du code d'un
        projet : son agent de projet y a accès.
      </p>
      <form onSubmit={submit} className={styles.form}>
        <Field label="Nom">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. DS Lumora Marketing" required />
        </Field>
        <Field
          label="Partir des pages d'un projet"
          optional
          hint="Claude reprend les couleurs, la typo et les composants déjà utilisés dans ce projet."
        >
          <Select size="lg" value={fromProjectId} onChange={(e) => setFromProjectId(e.target.value)}>
            <option value="">Aucun, partir de zéro</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Instructions pour Claude"
          optional
          hint="Si tu en donnes, ce sera le premier message de la première conversation du design system."
        >
          <Textarea
            aria-label="Instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            placeholder="L'esprit de la marque, les couleurs imposées, ce que le design system doit couvrir…"
          />
        </Field>
        <DialogActions>
          <Button size="lg" onClick={onClose}>
            Annuler
          </Button>
          <Button size="lg" variant="accent" type="submit" disabled={title.trim() === ""}>
            Créer le design system
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Schematic page sketch, alternating between the board's two layouts. */
function PreviewSheet({ variant }: { variant: number }) {
  return (
    <div className={styles.preview} aria-hidden="true">
      {variant % 2 === 0 ? (
        <div className={styles.sheet}>
          <div className={styles.row}>
            <div className={styles.logoMark} />
            <div className={styles.bar} style={{ height: 5, width: 56 }} />
            <div className={styles.grow} />
            <div className={styles.line} style={{ width: 20 }} />
            <div className={styles.line} style={{ width: 20 }} />
          </div>
          <div className={styles.bar} style={{ height: 9, width: "60%", marginTop: 4 }} />
          <div className={styles.line} style={{ width: "85%" }} />
          <div className={styles.row} style={{ marginTop: 6 }}>
            <div className={styles.tile} />
            <div className={styles.tile} />
            <div className={styles.tile} />
          </div>
        </div>
      ) : (
        <div className={styles.sheet}>
          <div className={styles.barLight} />
          <div className={styles.row} style={{ marginTop: 4 }}>
            <div className={styles.block} style={{ flex: "2 1 0" }} />
            <div className={styles.block} style={{ flex: "1 1 0" }} />
          </div>
          <div className={styles.line} style={{ width: "80%" }} />
          <div className={styles.line} style={{ width: "65%" }} />
          <div className={styles.ghostButton} />
        </div>
      )}
    </div>
  );
}

export function DesignSystemsScreen() {
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then((all) => setDesignSystems(all.filter((ds) => ds.id !== NEUTRAL_DESIGN_SYSTEM_ID)));
  }, []);

  return (
    <PageContent>
      <PageHeader
        title="Design systems"
        subtitle={
          <span className={styles.subtitle}>
            Un design system est un projet comme les autres : sa page principale sert d'aperçu, et tu le fais évoluer en commentant ses
            pages.
          </span>
        }
        actions={
          <Button variant="accent" size="lg" onClick={() => setCreating(true)}>
            Ajouter un design system
          </Button>
        }
      />
      <div className={styles.grid} data-testid="design-systems">
        {designSystems?.map((ds, index) => (
          <a key={ds.id} className={styles.card} data-testid="design-system" href={routeHref({ name: "page", pageId: ds.pageId })}>
            <PreviewSheet variant={index} />
            <div className={styles.body}>
              <div className={styles.name}>{ds.title}</div>
              <div className={styles.usedBy}>{usedByLabel(ds)}</div>
              {ds.updatedAt && <div className={styles.modified}>Modifié {relativeTime(ds.updatedAt)}</div>}
            </div>
          </a>
        ))}
        <button type="button" className={styles.add} onClick={() => setCreating(true)}>
          <span className={styles.plus} aria-hidden="true">
            +
          </span>
          <span className={styles.addTitle}>Ajouter un design system</span>
          <span className={styles.addHint}>De zéro, ou à partir des pages d'un projet</span>
        </button>
      </div>
      {creating && (
        <NewDesignSystemDialog
          onClose={() => setCreating(false)}
          onCreated={(ds) => {
            window.location.hash = routeHref({ name: "page", pageId: ds.pageId });
          }}
        />
      )}
    </PageContent>
  );
}
