import type { SendReviewRequest } from "@redline/shared";
import type { ModelEffortChoice } from "./ModelEffortControls.js";
import { Button } from "./ui/index.js";
import styles from "./Thread.module.css";

/** Sends "À relire" threads of a page to Claude, as one message: the given ones, or all of them. */
export async function sendToClaude(pageId: string, choice: ModelEffortChoice, threadIds?: string[]): Promise<void> {
  const request: SendReviewRequest = { ...choice, ...(threadIds ? { threadIds } : {}) };
  await fetch(`/api/pages/${pageId}/send-review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

/** Counter of the page's "À relire" threads, with "Tout envoyer à Claude" for members who work on the page. */
export function ReviewBar({ pageId, count, choice, canSend }: { pageId: string; count: number; choice: ModelEffortChoice; canSend: boolean }) {
  if (count === 0) return null;
  return (
    <div data-testid="review-bar" role="status" className={styles.reviewBar}>
      <span>
        <strong>{count === 1 ? "1 commentaire à relire" : `${count} commentaires à relire`}</strong> <span>(liens et membres en Commentaire)</span>
      </span>
      {canSend && (
        <Button size="sm" onClick={() => void sendToClaude(pageId, choice)}>
          Tout envoyer à Claude
        </Button>
      )}
    </div>
  );
}
