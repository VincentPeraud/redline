import { useCallback, useEffect, useState } from "react";
import { pageChangeReviewsPath, reviewPlace, type PageChangeReview, type ProjectDesignSystem } from "@redline/shared";
import { navigateTo } from "./router.js";
import { counted } from "./plural.js";
import { relativeTime } from "./relativeTime.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { Button } from "./ui/index.js";
import styles from "./ReviewBanners.module.css";

const nameOf = (person: { name: string; email: string } | undefined) => person?.name || person?.email;

/** "Vincent et Victor", "Vincent, Victor et Ariane". */
const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} et ${names.at(-1)}`);

/** "la conversation de Vincent (agora-maquettes)": the label, else the last segment of the session's folder. */
function conversationOf({ person, folder, label }: PageChangeReview["requester"], own: boolean): string {
  const where = reviewPlace({ label, folder });
  const owner = own ? "ta conversation" : nameOf(person) ? `la conversation de ${nameOf(person)}` : "la conversation";
  return `${owner} (${where})`;
}

/** The reviews that cover the page, kept up to date by the server events. */
function useReviewBanners(pageId: string): PageChangeReview[] {
  const [banners, setBanners] = useState<PageChangeReview[]>([]);
  const load = useCallback(async () => {
    const response = await fetch(pageChangeReviewsPath(pageId)).catch(() => undefined);
    if (response?.ok) setBanners((await response.json()) as PageChangeReview[]);
  }, [pageId]);
  useEffect(() => {
    void load();
    return subscribeServerEvents((event) => {
      if (event.type === "review-updated" && event.pageIds.includes(pageId)) void load();
    }, () => void load());
  }, [load, pageId]);
  return banners;
}

const open = (reviewId: string, step?: "recap") => navigateTo({ name: "review", reviewId, ...(step ? { step } : {}) });

function Icon({ done }: { done: boolean }) {
  return (
    <span className={styles.icon}>
      {done ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </span>
  );
}

function Band({ review, onHide }: { review: PageChangeReview; onHide: () => void }) {
  const requester = conversationOf(review.requester, review.viewerIsRequester);
  const ok = review.feedbackStepCount > 0 ? `${counted(review.okCount, "OK", "OK")}, ${counted(review.feedbackStepCount, "étape avec retours", "étapes avec retours")}` : counted(review.okCount, "OK", "OK");
  const common = { role: "status", "data-testid": "review-banner", "data-state": review.state } as const;

  if (review.state === "requested") {
    return (
      <div {...common} className={styles.band}>
        <Icon done={false} />
        <span className={styles.text}>
          <strong>
            Claude demande une revue · {counted(review.stepCount, "étape", "étapes")} sur {counted(review.pageTitles.length, "page", "pages")}
          </strong>
          <span>
            {review.pageTitles.join(", ")} · demandée {relativeTime(review.createdAt)} par {requester}
          </span>
        </span>
        <Button variant="accent" onClick={() => open(review.id)}>
          Commencer la revue
        </Button>
      </div>
    );
  }
  if (review.state === "in-progress") {
    const names = review.contributors.flatMap((person) => nameOf(person) ?? []);
    return (
      <div {...common} className={styles.band}>
        <Icon done={false} />
        <span className={styles.text}>
          <strong>
            Revue en cours · {review.seen} / {review.stepCount} vus
          </strong>
          <span>
            {ok}
            {names.length > 0 && ` · ${listed(names)} y ${names.length > 1 ? "ont" : "a"} contribué`}
          </span>
        </span>
        <span className={styles.bar} aria-hidden="true">
          <i style={{ width: `${(review.seen / review.stepCount) * 100}%` }} />
        </span>
        <Button variant="accent" onClick={() => open(review.id)}>
          Reprendre
        </Button>
      </div>
    );
  }
  if (review.state === "finished") {
    return (
      <div {...common} className={styles.band}>
        <Icon done />
        <span className={styles.text}>
          <strong>
            Revue terminée par {nameOf(review.finishedBy) ?? "quelqu'un"} · {ok} · en attente de récupération
          </strong>
          <span>
            {review.viewerIsRequester
              ? `Dis « j'ai fait mes retours » à ${requester} : elle viendra chercher les retours.`
              : `${requester[0]!.toUpperCase()}${requester.slice(1)} viendra chercher les retours. Ta conversation peut aussi les récupérer.`}
          </span>
        </span>
        <Button onClick={() => open(review.id, "recap")}>Voir le récapitulatif</Button>
      </div>
    );
  }
  return (
    <div {...common} className={`${styles.band} ${styles.fetched}`}>
      <Icon done />
      <span className={styles.text}>
        <strong>
          Retours récupérés par {nameOf(review.fetchedBy) ? `la conversation de ${nameOf(review.fetchedBy)}` : "une conversation"}
          {review.fetchedAt && ` ${relativeTime(review.fetchedAt)}`}
        </strong>
        <span>Le bandeau disparaît au prochain chargement.</span>
      </span>
      <Button variant="ghost" aria-label="Masquer le bandeau" onClick={onHide}>
        ✕
      </Button>
    </div>
  );
}

/** One banner per review covering the page, stacked under the canvas header. Shown to members with Écriture only (the caller checks). */
export function ReviewBanners({ pageId }: { pageId: string }) {
  const banners = useReviewBanners(pageId);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      {banners
        .filter((review) => !hidden.has(review.id))
        .map((review) => (
          <Band key={review.id} review={review} onHide={() => setHidden(new Set([...hidden, review.id]))} />
        ))}
    </>
  );
}

/** The design system a project follows in draft while its draft differs from the diffusion; kept up to date by the server events. */
function useDraftBand(pageId: string, projectId: string): { id: string; title: string; pendingChanges: number } | null {
  const [band, setBand] = useState<{ id: string; title: string; pendingChanges: number } | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/design-system`).catch(() => undefined);
    if (!response?.ok) return;
    const detail = (await response.json()) as ProjectDesignSystem;
    setBand(detail.followsDraft && detail.designSystem && detail.pendingChanges > 0 ? { ...detail.designSystem, pendingChanges: detail.pendingChanges } : null);
  }, [projectId]);
  useEffect(() => {
    void load();
    return subscribeServerEvents((event) => {
      if (event.type === "design-system-updated" && event.pageIds.includes(pageId)) void load();
    }, () => void load());
  }, [load, pageId]);
  return band;
}

/** Grey band under the canvas header of a page of a project that follows the design system draft, while the draft has changes not diffused yet. Link visitors see it without the button. */
export function DraftBand({ pageId, projectId, visitor }: { pageId: string; projectId: string; visitor: boolean }) {
  const band = useDraftBand(pageId, projectId);
  if (!band) return null;
  return (
    <div role="status" data-testid="draft-banner" className={`${styles.band} ${styles.draft}`}>
      <svg className={styles.draftIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
      <span className={styles.text}>
        <strong>Cette page utilise le brouillon de {band.title}</strong>
        <span>
          {counted(band.pendingChanges, "modification", "modifications")} de {band.title} {band.pendingChanges > 1 ? "pas encore diffusées s'appliquent" : "pas encore diffusée s'applique"} à ce projet. {band.pendingChanges > 1 ? "Elles peuvent" : "Elle peut"} encore changer.
        </span>
      </span>
      {!visitor && (
        <Button className={styles.draftAction} onClick={() => navigateTo({ name: "designSystem", designSystemId: band.id, viaProjectId: projectId })}>
          Ouvrir {band.title}
        </Button>
      )}
    </div>
  );
}
