import { useCallback, useEffect, useState } from "react";
import type { AccessLevel, Person, Project, ProjectMember, ProjectSharing, ProjectVisibility } from "@redline/shared";
import { Avatar } from "./Avatar.js";
import { useMe } from "./useMe.js";
import { VISIBILITY_LABEL } from "./VisibilityBadge.js";
import { Button, Dialog, DialogActions, Select, SegmentedControl, StatusBadge } from "./ui/index.js";
import styles from "./ProjectSharingDialog.module.css";

const VISIBILITY_OPTIONS = (["team", "private"] as const).map((value) => ({ value, label: VISIBILITY_LABEL[value] }));

export const LEVEL_LABEL: Record<AccessLevel, string> = { read: "Lecture", comment: "Commentaire", write: "Écriture" };
/** The order of the mock-up's lists: lowering an Équipe member starts from Commentaire, a Privé member from Écriture. */
const LOWERING_LEVELS: AccessLevel[] = ["comment", "read", "write"];
const CHOOSING_LEVELS: AccessLevel[] = ["write", "comment", "read"];
const JSON_HEADERS = { "content-type": "application/json" };

async function loadSharing(projectId: string): Promise<ProjectSharing> {
  return (await fetch(`/api/projects/${projectId}/sharing`)).json() as Promise<ProjectSharing>;
}

/** Who sees the project and at which level (`GET /api/projects/:id/sharing`), loaded once per project and reloaded when its visibility changes. */
export function useProjectSharing(projectId: string, visibility: ProjectVisibility | undefined, enabled: boolean): { sharing: ProjectSharing | null; reload: () => Promise<void> } {
  const [sharing, setSharing] = useState<ProjectSharing | null>(null);
  const reload = useCallback(async () => {
    if (enabled) setSharing(await loadSharing(projectId));
  }, [projectId, enabled]);
  useEffect(() => {
    void reload();
  }, [reload, visibility]);
  return { sharing, reload };
}

/** The "Partager" button of a project page: for the creator and the admins who change it, and for the members in Écriture who read it. */
export function ShareProjectButton({ project, sharing, reload, onChanged }: { project: Project; sharing: ProjectSharing | null; reload: () => Promise<void>; onChanged: (project: Project) => void }) {
  const [open, setOpen] = useState(false);
  if (!sharing || !(sharing.canChange || sharing.viewerLevel === "write")) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>Partager</Button>
      {open && <ProjectSharingDialog project={project} sharing={sharing} reload={reload} onChanged={onChanged} onClose={() => setOpen(false)} />}
    </>
  );
}

function LevelSelect({ label, value, levels, disabled, onChange }: { label: string; value: AccessLevel; levels: AccessLevel[]; disabled?: boolean; onChange: (level: AccessLevel) => void }) {
  return (
    <span className={disabled ? styles.dimmed : styles.undimmed}>
      <Select size="sm" aria-label={label} value={value} disabled={disabled} className={styles.levelSelect} onChange={(e) => onChange(e.target.value as AccessLevel)}>
        {levels.map((level) => (
          <option key={level} value={level}>
            {LEVEL_LABEL[level]}
          </option>
        ))}
      </Select>
    </span>
  );
}

function MemberRow({ member, levels, firstName, editable, onLevel, onRemove }: { member: ProjectMember; levels: AccessLevel[]; firstName: string; editable: boolean; onLevel: (level: AccessLevel) => void; onRemove: () => void }) {
  return (
    <div className={styles.row} data-testid="member-row">
      <Avatar initials={member.person.initials} muted />
      <div className={styles.main}>
        <strong>{member.person.name}</strong>
        <span>{member.person.email}</span>
      </div>
      <LevelSelect label={`Niveau ${firstName}`} value={member.level} levels={levels} disabled={!editable} onChange={onLevel} />
      <Button size="sm" variant="ghost" className={styles.remove} disabled={!editable} onClick={onRemove}>
        Retirer
      </Button>
    </div>
  );
}

/** Inline form to give a member a level: "Choisir un membre", a level, "Ajouter". */
function AddMember({ candidates, levels, onAdd }: { candidates: Person[]; levels: AccessLevel[]; onAdd: (personId: string, level: AccessLevel) => Promise<void> }) {
  const [personId, setPersonId] = useState("");
  const [level, setLevel] = useState<AccessLevel>(levels[0]);
  return (
    <div className={styles.add}>
      <Select size="sm" aria-label="Membre à ajouter" value={personId} className={styles.memberSelect} onChange={(e) => setPersonId(e.target.value)}>
        <option value="">Choisir un membre</option>
        {candidates.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </Select>
      <LevelSelect label="Niveau" value={level} levels={levels} onChange={setLevel} />
      <Button
        size="sm"
        variant="primary"
        aria-disabled={personId === ""}
        onClick={() => {
          if (personId !== "") void onAdd(personId, level).then(() => setPersonId(""));
        }}
      >
        Ajouter
      </Button>
    </div>
  );
}

function ProjectSharingDialog({ project, sharing, reload, onChanged, onClose }: { project: Project; sharing: ProjectSharing; reload: () => Promise<void>; onChanged: (project: Project) => void; onClose: () => void }) {
  const me = useMe();
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);

  async function setVisibility(visibility: ProjectVisibility) {
    const res = await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility }) });
    if (res.ok) onChanged((await res.json()) as Project);
    setConfirming(false);
  }

  function choose(visibility: ProjectVisibility) {
    if (visibility === project.visibility) return;
    if (visibility === "private" && sharing.wouldLoseAccess.length > 0) setConfirming(true);
    else if (visibility === "private") void setVisibility("private");
    else void setVisibility("team");
  }

  if (confirming) {
    const losing = sharing.wouldLoseAccess;
    return (
      <Dialog title={`Passer « ${project.title} » en privé ?`} width={520} onClose={() => setConfirming(false)}>
        <p className={styles.text}>
          Seuls toi, les admins et les membres que tu ajouteras ensuite verront ce projet.
        </p>
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
  const editable = sharing.canChange;

  async function call(method: "PUT" | "DELETE", personId: string, level?: AccessLevel) {
    await fetch(`/api/projects/${project.id}/members/${personId}`, { method, headers: JSON_HEADERS, body: JSON.stringify(level ? { level } : {}) });
    await reload();
  }
  const firstName = (member: ProjectMember) => member.person.name.split(" ")[0];
  const readOnlyText = creator ? `Seuls ${creator.name} (créateur) et les admins changent la visibilité et les niveaux.` : "Seuls les admins changent la visibilité et les niveaux.";
  const text = !editable ? readOnlyText : isPrivate ? "Seuls toi, les admins et les membres ajoutés ci-dessous voient ce projet." : "Tous les membres voient ce projet et y ont accès en Écriture. Tu peux baisser le niveau d'un membre.";
  const memberLevels = isPrivate ? CHOOSING_LEVELS : LOWERING_LEVELS;
  const addLevels = isPrivate ? CHOOSING_LEVELS : (["comment", "read"] as AccessLevel[]);

  return (
    <Dialog title={`Partager le projet ${project.title}`} width={640} gap={24} onClose={onClose}>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Visibilité</h3>
          <SegmentedControl<ProjectVisibility> size="md" ariaLabel="Visibilité" options={VISIBILITY_OPTIONS} value={project.visibility} onChange={choose} disabled={!editable} />
        </div>
        <p className={styles.text}>{text}</p>
        <div className={styles.list}>
          {isPrivate ? (
            creator && (
              <div className={styles.row}>
                <Avatar initials={creator.initials} muted />
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
          {sharing.members.map((member) => (
            <MemberRow
              key={member.person.id}
              member={member}
              levels={memberLevels}
              firstName={firstName(member)}
              editable={editable}
              onLevel={(level) => void call("PUT", member.person.id, level)}
              onRemove={() => void call("DELETE", member.person.id)}
            />
          ))}
        </div>
        {editable && !isPrivate && (
          <Button size="sm" className={styles.alone} aria-expanded={adding} disabled={sharing.candidates.length === 0} onClick={() => setAdding(!adding)}>
            Changer le niveau d'un membre
          </Button>
        )}
        {editable && (isPrivate || adding) && (
          <AddMember
            key={sharing.members.length}
            candidates={sharing.candidates}
            levels={addLevels}
            onAdd={async (personId, level) => {
              await call("PUT", personId, level);
              setAdding(false);
            }}
          />
        )}
      </section>
    </Dialog>
  );
}
