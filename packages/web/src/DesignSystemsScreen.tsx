import { useEffect, useState, type FormEvent } from "react";
import {
  type CreateDesignSystemRequest,
  type DesignSystem,
  type DesignSystemSummary,
  type Project,
} from "@redline/shared";
import { ArchiveIcon, archivedOnLabel } from "./ArchiveControls.js";
import { Button, Dialog, DialogActions, Field, PageContent, PageHeader, Select, Textarea, TextInput } from "./ui/index.js";
import { usedByLabel } from "./designSystemLabel.js";
import { componentCountLabel, pageCountLabel } from "./diffusionLabels.js";
import { navigateTo, routeHref } from "./router.js";
import { PendingPill, RequestsPill } from "./DesignSystemAlerts.js";
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

/** The design system's colours as the board draws them: two small squares, a large one and a pill. */
function PreviewSwatches({ palette }: { palette: string[] }) {
  const [first, second, third] = palette;
  return (
    <div className={styles.preview} aria-hidden="true">
      {first && <div className={styles.swatch} style={{ background: first }} />}
      {second && <div className={styles.swatch} style={{ background: second }} />}
      {third && <div className={styles.swatchLarge} style={{ background: third }} />}
      {first && <div className={styles.pill} style={{ background: first }} />}
    </div>
  );
}

export function DesignSystemsScreen() {
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
    fetch("/api/design-systems?archived=1")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then((archived) => setArchivedCount(archived.length));
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
        {designSystems?.map((ds) => (
          <a key={ds.id} className={styles.card} data-testid="design-system" href={routeHref({ name: "designSystem", designSystemId: ds.id })}>
            <PreviewSwatches palette={ds.palette} />
            <div className={styles.body}>
              <div className={styles.nameRow}>
                <div className={styles.name}>{ds.title}</div>
                {ds.pendingChanges > 0 && <PendingPill changes={ds.pendingChanges} />}
              </div>
              <div className={styles.usedBy}>{usedByLabel(ds)}</div>
              {(ds.requests > 0 || ds.pendingChanges > 0) && (
                <div className={styles.alertsRow}>
                  {ds.requests > 0 && <RequestsPill count={ds.requests} suffix=" des projets" />}
                  {ds.pendingChanges > 0 && (
                    <button
                      type="button"
                      data-testid="review-and-diffuse"
                      className={styles.review}
                      onClick={(event) => {
                        event.preventDefault();
                        navigateTo({ name: "designSystem", designSystemId: ds.id, review: true });
                      }}
                    >
                      Relire et diffuser
                    </button>
                  )}
                </div>
              )}
              <div data-testid="design-system-stats" className={styles.stats}>
                {pageCountLabel(ds.pageCount)} · {componentCountLabel(ds.componentCount)} · diffusion {ds.diffusion}
              </div>
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
      {archivedCount > 0 && (
        <a href={routeHref({ name: "archivedDesignSystems" })} className={styles.archivedLink}>
          <ArchiveIcon size={16} />
          Design systems archivés · {archivedCount}
          <span aria-hidden="true" className={styles.archivedChevron}>
            ›
          </span>
        </a>
      )}
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

/** "Design systems archivés": read-only design systems, each opened to be unarchived or deleted for good. */
export function ArchivedDesignSystemsScreen() {
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[] | null>(null);

  useEffect(() => {
    fetch("/api/design-systems?archived=1")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  return (
    <PageContent>
      <div className={styles.archivedHeading}>
        <nav aria-label="Fil d'Ariane" className={styles.archivedBreadcrumb}>
          <a href={routeHref({ name: "designSystems" })}>Design systems</a>
          <span aria-hidden="true">/</span>
          <span className={styles.archivedCurrent}>Archivés</span>
        </nav>
        <h1 className={styles.archivedTitle}>Design systems archivés</h1>
        <p className={styles.archivedIntro}>En lecture seule. Ouvre un design system pour le désarchiver ou le supprimer définitivement.</p>
      </div>
      <div className={styles.grid}>
        {designSystems?.map((ds) => (
          <a key={ds.id} className={styles.card} href={routeHref({ name: "designSystem", designSystemId: ds.id })}>
            <div className={styles.archivedPreview}>
              <PreviewSwatches palette={ds.palette} />
            </div>
            <div className={styles.body}>
              <div className={styles.nameRow}>
                <div className={styles.name}>{ds.title}</div>
                <span className={styles.archivedPill}>Archivé</span>
              </div>
              <div className={styles.usedBy}>
                {pageCountLabel(ds.pageCount)} · {componentCountLabel(ds.componentCount)}
              </div>
              {ds.archivedAt && <div className={styles.stats}>{archivedOnLabel(ds.archivedAt)}</div>}
            </div>
          </a>
        ))}
      </div>
    </PageContent>
  );
}
