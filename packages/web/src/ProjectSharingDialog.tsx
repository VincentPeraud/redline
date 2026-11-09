import { useEffect, useState } from "react";
import type { Project, ProjectSharing, ProjectVisibility } from "@redline/shared";
import { Avatar } from "./Avatar.js";
import { useMe } from "./useMe.js";
import { VISIBILITY_LABEL } from "./VisibilityBadge.js";
import { Button, Dialog, DialogActions, SegmentedControl, StatusBadge } from "./ui/index.js";
import styles from "./ProjectSharingDialog.module.css";

const VISIBILITY_OPTIONS = (["team", "private"] as const).map((value) => ({ value, label: VISIBILITY_LABEL[value] }));

async function loadSharing(projectId: string): Promise<ProjectSharing> {
  return (await fetch(`/api/projects/${projectId}/sharing`)).json() as Promise<ProjectSharing>;
}

/** The "Partager" button of a project page, for the people who decide who sees it (its creator and the admins). */
export function ShareProjectButton({ project, onChanged }: { project: Project; onChanged: (project: Project) => void }) {
  const [sharing, setSharing] = useState<ProjectSharing | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void loadSharing(project.id).then(setSharing);
  }, [project.id, project.visibility]);
  if (!sharing?.canChange) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>Partager</Button>
      {open && <ProjectSharingDialog project={project} sharing={sharing} onChanged={onChanged} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProjectSharingDialog({ project, sharing, onChanged, onClose }: { project: Project; sharing: ProjectSharing; onChanged: (project: Project) => void; onClose: () => void }) {
  const me = useMe();
  const [confirming, setConfirming] = useState(false);

  async function setVisibility(visibility: ProjectVisibility) {
    const res = await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility }) });
    if (res.ok) onChanged((await res.json()) as Project);
    setConfirming(false);
  }

  function choose(visibility: ProjectVisibility) {
    if (visibility === project.visibility) return;
    if (visibility === "private") setConfirming(true);
    else void setVisibility("team");
  }

  if (confirming) {
    const losing = sharing.wouldLoseAccess;
    return (
      <Dialog title={`Passer « ${project.title} » en privé ?`} width={520} onClose={() => setConfirming(false)}>
        <p className={styles.text}>
          Seuls toi, les admins et les membres que tu ajouteras ensuite verront ce projet.
        </p>
        {losing.length > 0 ? (
          <div className={styles.list} data-testid="lose-access">
            {losing.map((person) => (
              <div key={person.id} className={styles.row}>
                <Avatar initials={person.initials} />
                <div className={styles.main}>
                  <strong>{person.name}</strong>
                  <span>{person.email}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.text}>Personne ne perd l'accès.</p>
        )}
        <DialogActions>
          <Button size="lg" onClick={() => setConfirming(false)}>
            Annuler
          </Button>
          <Button variant="accent" size="lg" onClick={() => void setVisibility("private")}>
            Passer en privé
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  const isPrivate = project.visibility === "private";
  const creator = sharing.createdBy;
  return (
    <Dialog title={`Partager le projet ${project.title}`} width={640} gap={24} onClose={onClose}>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Visibilité</h3>
          <SegmentedControl<ProjectVisibility> ariaLabel="Visibilité" options={VISIBILITY_OPTIONS} value={project.visibility} onChange={choose} />
        </div>
        <p className={styles.text}>
          {isPrivate ? "Seuls toi, les admins et les membres ajoutés ci-dessous voient ce projet." : "Tous les membres voient ce projet et y ont accès en Écriture."}
        </p>
        <div className={styles.list}>
          {isPrivate ? (
            creator && (
              <div className={styles.row}>
                <Avatar initials={creator.initials} />
                <div className={styles.main}>
                  <strong>
                    {creator.name}
                    {creator.id === me?.id && " (toi)"}
                  </strong>
                  <span>créateur du projet</span>
                </div>
                <StatusBadge tone="neutral">Écriture</StatusBadge>
              </div>
            )
          ) : (
            <div className={styles.row}>
              <span className={styles.icon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <circle cx="9" cy="8" r="3.5" />
                  <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
                  <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
                  <path d="M18.5 14a6.5 6.5 0 0 1 3 6" />
                </svg>
              </span>
              <div className={styles.main}>
                <strong>Tous les membres</strong>
                <span>{sharing.accountCount} {sharing.accountCount > 1 ? "personnes" : "personne"}</span>
              </div>
              <StatusBadge tone="neutral">Écriture</StatusBadge>
            </div>
          )}
        </div>
      </section>
    </Dialog>
  );
}
