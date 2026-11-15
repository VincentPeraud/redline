import { activeSteps, reviewPlace, stepIsGroup, stepIsSeen, stepLabel, stepStatus, type ArtboardRef, type ChangeReview, type ChangeReviewAnswer, type ChangeReviewStep } from "@redline/shared";
import { cx } from "./ui/index.js";
import { personName } from "./ReviewRemark.js";
import { type RemovedRemark, type View, formatWhen, lockTitle, neighbour, titleOfArtboard } from "./reviewView.js";
import styles from "./ReviewScreen.module.css";

const nameOfAnswer = (answer: ChangeReviewAnswer, own: string) => (answer.mine ? own : personName(answer.person));

/** "Victor avait validé cette étape" next to a remark of someone else on a step several people looked at. */
function alsoValidated(step: ChangeReviewStep): string {
  const validators = step.answers.filter((answer) => answer.kind === "ok" && !answer.outdated);
  if (validators.length === 0) return "";
  if (validators.length === 1) return validators[0]!.mine ? " · tu avais validé cette étape" : ` · ${personName(validators[0]!.person)} avait validé cette étape`;
  return ` · ${validators.map((answer) => nameOfAnswer(answer, "toi")).join(" et ")} avaient validé cette étape`;
}

export function ReviewRecap({
  review,
  failed,
  removed,
  onGo,
  onFinish,
  onReopen,
  onFile,
  onRemove,
  onRestore,
}: {
  review: ChangeReview;
  failed: boolean;
  removed: RemovedRemark | undefined;
  onGo: (view: View) => void;
  onFinish: () => void;
  onReopen: () => void;
  onFile: () => void;
  onRemove: (answerId: string, stepId: string, text: string, title: string, on?: ArtboardRef) => void;
  onRestore: () => void;
}) {
  const open = review.state === "open";
  const kept = activeSteps(review.steps);
  const okSteps = kept.filter((step) => stepStatus(step.answers) === "ok");
  const remarks = review.steps.flatMap((step) => step.answers.filter((answer) => answer.kind === "remark").map((answer) => ({ step, answer })));
  const notSeen = kept.filter((step) => !stepIsSeen(step));
  const titleOf = stepLabel;
  const indexOf = (step: ChangeReviewStep) => review.steps.indexOf(step);
  const place = reviewPlace(review.requester);
  const requester = personName(review.requester.person);
  return (
    <div className={styles.screen}>
      <div className={styles.recap}>
        <div className={styles.recapSide}>
          <div className={cx(styles.recapHead, !open && styles.recapHeadLocked)}>
            <h1>{open ? "Avant de terminer" : "Revue terminée"}</h1>
            {open && <p className={styles.recapNote}>Tant que la revue n'est pas terminée, chacun peut encore changer ses remarques.</p>}
            {review.state === "finished" && (
              <div className={styles.done}>
                <strong>
                  {lockTitle(review)} · {review.finishedAt ? formatWhen(review.finishedAt) : ""}
                </strong>
                <span>
                  {review.viewerIsRequester ? "Dis maintenant à ta conversation" : `${requester} peut maintenant dire à sa conversation`} <span className={styles.quote}>{place}</span> que{" "}
                  {review.viewerIsRequester ? "tes retours sont prêts (par exemple « j'ai fait mes retours »)" : "les retours sont prêts"} : elle viendra les chercher. Rien n'est envoyé avant.
                </span>
              </div>
            )}
            {review.state === "fetched" && (
              <div className={styles.done}>
                <strong>
                  {lockTitle(review)} ({place}) · {review.fetchedAt ? formatWhen(review.fetchedAt) : ""}
                </strong>
                <span>
                  {remarks.length === 0 ? "" : remarks.length === 1 ? "La remarque est devenue un fil sur son artboard. " : `Les ${remarks.length} remarques sont devenues des fils sur leurs artboards. `}Cette revue reste lisible ici.
                </span>
              </div>
            )}
            {review.state === "filed" && (
              <div className={cx(styles.done, styles.doneNeutral)}>
                <strong>
                  {lockTitle(review)} · {review.filedAt ? formatWhen(review.filedAt) : ""}
                </strong>
                <span>Ces retours n'ont jamais été transmis à une conversation. La revue reste lisible ici et ne peut plus être rouverte.</span>
              </div>
            )}
          </div>
          <div className={styles.sum}>
            <div className={styles.sumCard}>
              <b>{okSteps.length}</b>
              <span>OK</span>
            </div>
            <div className={styles.sumCard}>
              <b>{remarks.length}</b>
              <span>{remarks.length > 1 ? "Remarques" : "Remarque"}</span>
            </div>
            <div className={styles.sumCard}>
              <b>{notSeen.length}</b>
              <span>Non vus</span>
            </div>
          </div>
          {open && (
            <div className={styles.recapFoot}>
              <button type="button" className={styles.panelButton} onClick={() => onGo(neighbour(review, review.steps.length, -1)!)} disabled={kept.length === 0}>
                ← Revenir aux étapes
              </button>
              <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onFinish}>
                Terminer la revue
              </button>
              {failed && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>}
            </div>
          )}
          {review.state === "finished" && (
            <div className={styles.twoButtons}>
              <button type="button" className={styles.panelButton} onClick={onReopen}>
                Rouvrir la revue
              </button>
              <button type="button" className={styles.panelButton} onClick={onFile}>
                Classer sans envoyer
              </button>
            </div>
          )}
          {(review.state === "fetched" || review.state === "filed") && <span className={styles.recapNote}>Lecture seule : retour au canvas par le bouton en haut à gauche.</span>}
          {failed && !open && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>}
          {removed && (
            <div className={removed.lost ? styles.lostText : styles.undoLine}>
              {removed.lost ? (
                <>
                  <span>La revue s'est terminée : la remarque effacée sur {removed.title} n'est pas remise. Son texte :</span>
                  <textarea className={styles.textarea} readOnly value={removed.text} aria-label="Texte de la remarque effacée" />
                </>
              ) : (
                <>
                  Remarque effacée ({removed.title})
                  <button type="button" className={styles.linkButton} onClick={onRestore}>
                    Annuler
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className={styles.recapList}>
          {remarks.length > 0 && <div className={styles.group}>Remarques</div>}
          {remarks.map(({ step, answer }) => (
            <div key={answer.id} className={styles.item}>
              <span className={cx(styles.dot, styles.dotRemark)} />
              <div className={styles.itemBody}>
                <span className={styles.itemTitle}>
                  {titleOf(step)}
                  {stepIsGroup(step) && ` · sur ${titleOfArtboard(step, answer.on ?? step)}`}
                  {step.removed && ` · ${step.removed === "deleted" ? "artboard supprimé" : "page archivée"}`}
                </span>
                <span className={styles.itemText}>{answer.text}</span>
                <span className={styles.itemBy}>
                  {nameOfAnswer(answer, "Toi")}
                  {alsoValidated(step)}
                </span>
              </div>
              {open && answer.mine && (
                <div className={styles.itemActions}>
                  {!step.removed && (
                    <button type="button" className={styles.panelButton} onClick={() => onGo(indexOf(step))}>
                      Modifier
                    </button>
                  )}
                  <button type="button" className={styles.panelButton} onClick={() => onRemove(answer.id, step.id, answer.text ?? "", titleOf(step), answer.on)}>
                    Effacer
                  </button>
                </div>
              )}
            </div>
          ))}
          {okSteps.length > 0 && <div className={styles.group}>OK</div>}
          {okSteps.length > 0 && (
            <div className={styles.item}>
              <span className={cx(styles.dot, styles.dotOk)} />
              <div className={styles.itemBody}>
                <span className={styles.stepList}>{okSteps.map((step) => `${titleOf(step)} (${step.answers.filter((answer) => !answer.outdated).map((answer) => nameOfAnswer(answer, "toi")).join(", ")})`).join(", ")}</span>
              </div>
            </div>
          )}
          {notSeen.length > 0 && <div className={styles.group}>Non vus ({notSeen.length})</div>}
          {notSeen.length > 0 && (
            <div className={styles.item}>
              <span className={styles.dot} />
              <div className={styles.itemBody}>
                <span className={styles.stepList}>
                  {notSeen.map((step, position) => (
                    <span key={step.id}>
                      {position > 0 && ", "}
                      <button type="button" className={styles.stepLink} onClick={() => onGo(indexOf(step))}>
                        {titleOf(step)}
                      </button>
                      {step.answers.length > 0 && " (modifié depuis ton OK)"}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
