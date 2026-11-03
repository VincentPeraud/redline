import { requestOriginLabel, type RequestOrigin, type Thread, type ThreadRequest } from "@redline/shared";
import { routeHref } from "./router.js";
import { cx } from "./ui/index.js";
import styles from "./Thread.module.css";

/** "En cours" while the design system's session works on it, "Faite dans le brouillon" once a change is recorded; a closed request has no pill. */
const STATE_LABELS: Partial<Record<ThreadRequest["state"], string>> = {
  in_progress: "En cours",
  done_in_draft: "Faite dans le brouillon",
};

/** The "demande" tag in the card header. */
export function RequestTag() {
  return <span className={styles.requestTag}>demande</span>;
}

/** The pill under the header: where the request stands. */
export function RequestStatePill({ request }: { request: ThreadRequest }) {
  const label = STATE_LABELS[request.state];
  if (!label) return null;
  return (
    <div>
      <span data-testid="request-state" data-state={request.state} className={cx(styles.requestState, request.state === "done_in_draft" && styles.requestStateDone)}>
        {label}
      </span>
    </div>
  );
}

function InstanceLink({ origin }: { origin: RequestOrigin }) {
  return (
    <a href={routeHref({ name: "page", pageId: origin.pageId, artboard: origin.artboard })} className={styles.originLink}>
      voir l'instance ↗
    </a>
  );
}

/**
 * Where the request comes from, one line per origin: "Demandé par App · Planning", "Aussi demandé par …" for the
 * next ones, "Ton commentaire sur App · Planning, transmis par Claude · App" when it was born of the user's comment.
 */
export function RequestOrigins({ request }: { request: ThreadRequest }) {
  return (
    <div data-testid="request-origins" className={styles.origins}>
      {request.origins.map((origin, index) => (
        <div key={`${origin.pageId}:${origin.threadId ?? origin.selector ?? index}`}>
          {origin.threadId ? (
            <>
              Ton commentaire sur <b>{requestOriginLabel(origin)}</b>, transmis par Claude · {origin.projectTitle}
            </>
          ) : (
            <>
              {index === 0 ? "Demandé par" : "Aussi demandé par"} <b>{requestOriginLabel(origin)}</b>
            </>
          )}{" "}
          · <InstanceLink origin={origin} />
        </div>
      ))}
    </div>
  );
}

/** "Claude · App" for the project's session that asked; undefined when the words are the user's own (their name shows). */
export function requestAskerName(thread: Thread): string | undefined {
  const origin = thread.request?.origins[0];
  return origin && !origin.threadId ? `Claude · ${origin.projectTitle}` : undefined;
}

export const DESIGN_SYSTEM_CLAUDE = "Claude · design system";
