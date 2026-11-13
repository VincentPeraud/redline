import { useCallback, useEffect, useState } from "react";
import { pageChangeReviewsPath, type PageChangeReview } from "@redline/shared";
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
  const where = label ?? folder.split("/").filter(Boolean).pop() ?? folder;
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
  const ok = review.remarkCount > 0 ? `${counted(review.okCount, "OK", "OK")}, ${counted(review.remarkCount, "remarque", "remarques")}` : counted(review.okCount, "OK", "OK");
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
