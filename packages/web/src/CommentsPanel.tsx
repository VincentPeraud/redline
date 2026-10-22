import { Fragment, useState, type ReactNode } from "react";
import type { QueueEntry, SessionRow, Thread, ThreadRun } from "@redline/shared";
import { CreatedPageCards } from "./CreatedPageCards.js";
import { ContextLine } from "./ContextLine.js";
import { HeldBar, HeldThreadCard } from "./HeldComments.js";
import { ModelEffortControls, type AgentDefaults, type ModelEffortChoice } from "./ModelEffortControls.js";
import { queueLabel } from "./queueLabel.js";
import { relativeTime } from "./relativeTime.js";
import { RunProgress } from "./RunProgress.js";
import { shortSessionId } from "./sessionLabel.js";
import { threadWhere } from "./threadLabel.js";
import { ThreadReplyForm } from "./ThreadReplyForm.js";
import { Button, Textarea, cx } from "./ui/index.js";
import styles from "./Thread.module.css";
import panel from "./CommentsPanel.module.css";

export interface Draft {
  artboard: string;
  selector: string;
  elementName?: string;
}

interface Props {
  pageId: string;
  threads: Thread[];
  queue: QueueEntry[];
  runs: ThreadRun[];
  sessions: Map<string, SessionRow>;
  defaults: AgentDefaults;
  choice: ModelEffortChoice;
  onChoice: (choice: ModelEffortChoice) => void;
  draft: Draft | null;
  text: string;
  onText: (text: string) => void;
  /** `held`: "Plus tard", keeps the comment until "Tout envoyer". */
  onSend: (held: boolean) => void;
  onCancel: () => void;
}

const GROUP_ORDER: Record<Thread["status"], number> = { held: 0, open: 1, resolved: 2 };

function ThreadHeader({ thread, children }: { thread: Thread; children?: ReactNode }) {
  return (
    <div className={styles.head}>
      <span className={styles.badge}>{thread.number}</span>
      <span className={styles.where}>{threadWhere(thread)}</span>
      <span className={styles.spacer} />
      {children}
    </div>
  );
}

function ThreadCard({
  thread,
  queued,
  run,
  session,
  choice,
  onResolve,
}: {
  thread: Thread;
  queued: string | undefined;
  run: ThreadRun | undefined;
  session: SessionRow | undefined;
  choice: ModelEffortChoice;
  onResolve: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const active = !queued && run !== undefined && run.status !== "answered" && run.status !== "failed";
  const failed = !queued && run?.status === "failed";

  const messages = (
    <>
      <div className={styles.message}>
        <span className={styles.author}>Toi</span> — {thread.body}
      </div>
      {thread.replies.map((reply) => (
        <Fragment key={reply.id}>
          <div data-testid="reply" className={cx(styles.message, reply.author === "claude" && styles.claudeReply)}>
            <span className={styles.author}>{reply.author === "user" ? "Toi" : "Claude"}</span> — {reply.body}
          </div>
          <CreatedPageCards pages={reply.createdPages} />
        </Fragment>
      ))}
    </>
  );

  if (failed) {
    return (
      <article className={cx(styles.card, styles.failed)}>
        <div className={styles.head}>
          <span className={cx(styles.badge, styles.badgeFailed)}>{thread.number}</span>
          <span className={styles.where}>{threadWhere(thread)}</span>
          <span className={styles.spacer} />
          <span data-testid="run-status" data-status="failed" className={styles.headFailed}>
            Échec
          </span>
        </div>
        {run && <RunProgress run={run} />}
      </article>
    );
  }

  return (
    <article className={cx(styles.card, active && styles.running)}>
      <ThreadHeader thread={thread}>
        {queued && (
          <span data-testid="queued" className={styles.queued}>
            {queued}
          </span>
        )}
      </ThreadHeader>
      {messages}
      {run && !queued && <RunProgress run={run} />}
      {active ? (
        session?.sessionId && <span className={styles.sessionMeta}>session {shortSessionId(session.sessionId)}</span>
      ) : (
        <div className={styles.footer}>
          <span className={styles.sessionMeta}>
            {session?.sessionId && (
              <>
                session {shortSessionId(session.sessionId)}
                <br />
              </>
            )}
            {session && relativeTime(session.activityAt)}
          </span>
          <span className={styles.spacer} />
          <Button size="sm" aria-expanded={replying} onClick={() => setReplying(!replying)}>
            Répondre
          </Button>
          <Button size="sm" variant="primary" onClick={onResolve}>
            Résoudre
          </Button>
        </div>
      )}
      {replying && !active && <ThreadReplyForm threadId={thread.id} choice={choice} onDone={() => setReplying(false)} />}
      <ContextLine thread={thread} />
    </article>
  );
}

/** The "Commentaires" tab: held bar, thread cards and the composer of a new pinned comment. */
export function CommentsPanel({ pageId, threads, queue, runs, sessions, defaults, choice, onChoice, draft, text, onText, onSend, onCancel }: Props) {
  const ordered = [...threads].sort((a, b) => GROUP_ORDER[a.status] - GROUP_ORDER[b.status] || a.number - b.number);
  const heldCount = threads.filter((t) => t.status === "held").length;

  return (
    <>
      <div className={panel.list}>
        <HeldBar pageId={pageId} count={heldCount} choice={choice} />
        {ordered.map((thread) => {
          if (thread.status === "held") return <HeldThreadCard key={thread.id} thread={thread} />;
          if (thread.status === "resolved") {
            return (
              <article key={thread.id} className={cx(styles.card, styles.resolved)}>
                <span className={cx(styles.badge, styles.badgeDone)} aria-hidden="true">
                  ✓
                </span>
                <span className={styles.resolvedTitle}>{thread.title}</span>
                <span className={styles.spacer} />
                <span>Résolu</span>
              </article>
            );
          }
          return (
            <ThreadCard
              key={thread.id}
              thread={thread}
              queued={queueLabel(queue, thread.id)}
              run={runs.filter((r) => r.threadIds.includes(thread.id)).slice(-1)[0]}
              session={sessions.get(thread.id)}
              choice={choice}
              onResolve={() => void fetch(`/api/threads/${thread.id}/resolve`, { method: "POST" })}
            />
          );
        })}
        {threads.length === 0 && <p className={panel.empty}>Pas encore de commentaire. Passe en mode commentaire (C) et clique sur un élément.</p>}
      </div>
      <div className={panel.composer}>
        <label htmlFor="new-comment" className={panel.label}>
          Nouveau commentaire
        </label>
        {draft && (
          <div className={panel.draft}>
            <span>
              Commentaire sur <code>{draft.elementName ?? draft.selector}</code>
            </span>
            <button type="button" className={panel.cancel} onClick={onCancel}>
              Annuler
            </button>
          </div>
        )}
        <Textarea
          id="new-comment"
          rows={3}
          className={panel.textarea}
          placeholder="Clique sur un élément pour épingler ton commentaire…"
          disabled={!draft}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend(e.metaKey || e.ctrlKey);
            }
          }}
        />
        <div className={panel.actions}>
          <Button className={panel.action} aria-disabled={!draft || text.trim() === ""} title="Garde ce commentaire pour l'envoyer avec les autres (⌘ Entrée)" onClick={() => onSend(true)}>
            Plus tard
          </Button>
          <Button className={panel.action} variant="primary" aria-disabled={!draft || text.trim() === ""} title="Envoie ce commentaire tout de suite, seul (Entrée)" onClick={() => onSend(false)}>
            Envoyer
          </Button>
        </div>
        <ModelEffortControls value={choice} onChange={onChoice} defaults={defaults} />
      </div>
    </>
  );
}
