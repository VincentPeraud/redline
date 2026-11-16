import { reviewPlace, type ChangeReview } from "@redline/shared";
import { navigateTo } from "./router.js";
import { cx } from "./ui/index.js";
import { counted } from "./plural.js";
import { personName } from "./ReviewRemark.js";
import { type Load, type View, neighbour } from "./reviewView.js";
import styles from "./ReviewScreen.module.css";

const STATE_TEXTS = {
  missing: { title: "Revue introuvable", detail: "Ce lien ne correspond à aucune revue : il est incomplet, ou le projet a été supprimé. Le lien d'une revue classée ouvre toujours son récapitulatif." },
  refused: {
    title: "Revue réservée aux membres de l'équipe en Écriture",
    detail: "Ton accès à cette page (membre en Lecture ou Commentaire, ou lien de partage) ne permet pas de participer à la revue. Tu peux toujours commenter les artboards depuis le canvas si ton accès le permet.",
  },
  error: { title: "La revue n'a pas pu se charger", detail: "Le serveur Redline ne répond pas. Tes OK et tes retours déjà faits sont enregistrés." },
} as const;

/** "Les 9 artboards de cette revue ont été supprimés depuis la demande." */
function emptyDetail(review: ChangeReview): string {
  const count = review.steps.length;
  const verb = review.steps.every((entry) => entry.removed === "deleted") ? "supprimé" : "supprimé ou archivé";
  const lead = count > 1 ? `Les ${count} artboards de cette revue ont été ${verb}s` : `L'artboard de cette revue a été ${verb}`;
  return `${lead} depuis la demande. Demande à Claude de refaire la revue si besoin.`;
}

/** The screens with nothing to review: loading, error (the title of the last review shown stays), empty, refused, not found. */
export function StateScreen({ status, review, onRetry }: { status: Exclude<Load["status"], "ready"> | "empty"; review?: ChangeReview; onRetry: () => void }) {
  const text = status === "loading" ? undefined : status === "empty" ? { title: "Plus rien à revoir", detail: emptyDetail(review!) } : STATE_TEXTS[status];
  const toCanvas = () => navigateTo(review ? { name: "project", projectId: review.projectId } : { name: "home" });
  const requester = review?.requester.person;
  const place = review ? reviewPlace(review.requester) : "";
  return (
    <div data-testid="review" className={styles.review}>
      <header data-testid="review-top" className={styles.top}>
        <div className={styles.lead}>
          <button type="button" className={styles.button} onClick={() => navigateTo({ name: "home" })}>
            ← Canvas
          </button>
          <span className={styles.mode}>Revue</span>
          {review && (status === "error" || status === "empty") && (
            <span data-testid="review-title" className={styles.title}>
              Revue{requester ? <> de <strong>{personName(requester)}</strong></> : ""} · {place} · {review.projectTitle}
            </span>
          )}
        </div>
      </header>
      <div className={styles.stateScreen}>
        {text ? (
          <div className={styles.stateBox} role={status === "error" ? "alert" : undefined}>
            <h1>{text.title}</h1>
            <p>{text.detail}</p>
            <div className={styles.stateActions}>
              {status === "error" && (
                <button type="button" className={cx(styles.stateButton, styles.stateButtonLight)} onClick={onRetry}>
                  Réessayer
                </button>
              )}
              <button type="button" className={styles.stateButton} onClick={toCanvas}>
                {status === "missing" ? "Retour au projet" : "Retour au canvas"}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.stateBox} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <p>Chargement de la revue</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** A step whose artboard was deleted, or whose page is archived: nothing to review, and it is not counted. */
export function RemovedStep({ review, index, onGo }: { review: ChangeReview; index: number; onGo: (view: View) => void }) {
  const step = review.steps[index]!;
  const title = `${step.pageTitle} · ${step.artboardTitle}`;
  const next = neighbour(review, index, 1);
  const deleted = step.removed === "deleted";
  return (
    <div className={styles.stateScreen}>
      <div className={styles.stateBox} data-testid="review-removed">
        <h1>{deleted ? "Cet artboard n'existe plus" : "Cet artboard n'est plus disponible"}</h1>
        <p>
          {deleted
            ? `« ${title} » a été supprimé depuis la demande de revue. L'étape est retirée du compte.`
            : `« ${title} » est sur une page archivée. L'étape est retirée du compte${review.state === "open" ? " tant que la page n'est pas désarchivée." : "."}`}
        </p>
        <div className={styles.stateActions}>
          <button type="button" className={cx(styles.stateButton, styles.stateButtonLight)} onClick={() => onGo(next ?? "recap")}>
            {next === undefined ? "Récapitulatif →" : "Étape suivante →"}
          </button>
        </div>
      </div>
    </div>
  );
}
