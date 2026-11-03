import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { QueueEntry, SessionRow, Thread, ThreadRun } from "@redline/shared";
import { CreatedPageCards } from "./CreatedPageCards.js";
import { ContextLine } from "./ContextLine.js";
import { RemovedTag } from "./RemovedTag.js";
import { HeldBar, HeldThreadCard } from "./HeldComments.js";
import { MessageAuthor } from "./MessageAuthor.js";
import { ModelEffortControls, type AgentDefaults, type ModelEffortChoice } from "./ModelEffortControls.js";
import { InstanceGoneNote } from "./InstanceThreads.js";
import { RenderingChip } from "./RenderingChip.js";
import { DESIGN_SYSTEM_CLAUDE, RequestOrigins, RequestStatePill, RequestTag, requestAskerName } from "./RequestThreads.js";
import { queueLabel } from "./queueLabel.js";
import { relativeTime } from "./relativeTime.js";
import { RunProgress } from "./RunProgress.js";
import { shortSessionId } from "./sessionLabel.js";
import { threadWhere, wholeArtboardOf } from "./threadLabel.js";
import { useStickToBottom } from "./useStickToBottom.js";
import { ThreadReplyForm } from "./ThreadReplyForm.js";
import { Button, Textarea, cx } from "./ui/index.js";
import styles from "./Thread.module.css";
import panel from "./CommentsPanel.module.css";

export interface Draft {
  /** What the comment is about, as shown in the form. */
  label: string;
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
  /** An archived project's (or archived) page: threads are read, none is added, answered or resolved. */
  readOnly?: boolean;
  /** What is archived, opening the read-only note: "Projet archivé" (default) or "Page archivée". */
  archivedLabel?: string;
  /** Resolved threads unfolded in the list: their pins show again on the canvas. */
  unfolded: ReadonlySet<string>;
  onUnfold: (threadId: string, open: boolean) => void;
  /** A click on a thread's card (not on one of its controls): the canvas goes to where the comment is. */
  onShowThread?: (threadId: string) => void;
}

const GROUP_ORDER: Record<Thread["status"], number> = { held: 0, open: 1, resolved: 2 };

function ThreadHeader({ thread, children }: { thread: Thread; children?: ReactNode }) {
  return (
    <>
      <div className={styles.head}>
        <span className={cx(styles.badge, thread.removed && styles.badgeRemoved)}>{thread.number}</span>
        <span className={styles.where}>{threadWhere(thread)}</span>
        <RenderingChip thread={thread} />
        <span className={styles.spacer} />
        {thread.removed && <RemovedTag />}
        {thread.request && <RequestTag />}
        {children}
      </div>
      {thread.request && (
        <>
          <RequestStatePill request={thread.request} />
          <RequestOrigins request={thread.request} />
        </>
      )}
      <InstanceGoneNote thread={thread} />
    </>
  );
}

/** "session terminal" for a thread a terminal session handles, else "session 7c2e…a91". */
function sessionLabel(session: SessionRow | undefined): string | undefined {
  if (session?.terminal) return "session terminal";
  return session?.sessionId ? `session ${shortSessionId(session.sessionId)}` : undefined;
}

/** "session 7c2e…a91" over "il y a 2 min", in a card's footer. */
function SessionMeta({ session }: { session: SessionRow | undefined }) {
  return (
    <span className={styles.sessionMeta}>
      {sessionLabel(session) && (
        <>
          {sessionLabel(session)}
          <br />
        </>
      )}
      {session && relativeTime(session.activityAt)}
    </span>
  );
}

/** The comment and its replies, as the card of an open or a resolved thread shows them. */
function ThreadMessages({ thread }: { thread: Thread }) {
  return (
    <>
      <div className={styles.message}>
        <MessageAuthor person={thread.person} claude={requestAskerName(thread)} />
        {thread.body}
      </div>
      {thread.replies.map((reply) => (
        <Fragment key={reply.id}>
          <div data-testid="reply" className={cx(styles.message, reply.author === "claude" && styles.claudeReply)}>
            {reply.author === "user" ? <MessageAuthor person={reply.person} /> : <MessageAuthor claude={thread.request ? DESIGN_SYSTEM_CLAUDE : true} />}
            {reply.body}
          </div>
          <CreatedPageCards pages={reply.createdPages} />
        </Fragment>
      ))}
    </>
  );
}

/** A resolved thread: one line, which unfolds the discussion read-only, with "Rouvrir" to put it back among the open threads. */
function ResolvedThreadCard({ thread, session, readOnly, open, onOpen }: { thread: Thread; session: SessionRow | undefined; readOnly: boolean; open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <article data-thread={thread.id} data-whole-artboard={wholeArtboardOf(thread)} className={cx(styles.card, styles.resolved, thread.removed && styles.removed)}>
      <button type="button" aria-expanded={open} className={styles.resolvedRow} onClick={() => onOpen(!open)}>
        <span className={cx(styles.badge, styles.badgeDone, thread.removed && styles.badgeRemoved)} aria-hidden="true">
          ✓
        </span>
        <span className={styles.resolvedTitle}>{thread.title}</span>
        <span className={styles.spacer} />
        {thread.removed && <RemovedTag />}
        <span className={styles.resolvedLabel}>Résolu</span>
        <svg aria-hidden="true" className={styles.resolvedChevron} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
        </svg>
      </button>
      {open && (
        <div className={styles.resolvedBody}>
          <div className={styles.head}>
            <span className={styles.where}>{threadWhere(thread)}</span>
            <RenderingChip thread={thread} />
          </div>
          <ThreadMessages thread={thread} />
          <div className={styles.footer}>
            <SessionMeta session={session} />
            <span className={styles.spacer} />
            {!readOnly && (
              <Button size="sm" onClick={() => void fetch(`/api/threads/${thread.id}/reopen`, { method: "POST" })}>
                Rouvrir
              </Button>
            )}
          </div>
          <ContextLine thread={thread} />
        </div>
      )}
    </article>
  );
}

function ThreadCard({
  thread,
  queued,
  waitingForTerminal,
  run,
  session,
  choice,
  onResolve,
  readOnly,
}: {
  thread: Thread;
  queued: string | undefined;
  waitingForTerminal: boolean;
  run: ThreadRun | undefined;
  session: SessionRow | undefined;
  choice: ModelEffortChoice;
  onResolve: () => void;
  readOnly: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const active = !queued && run !== undefined && run.status !== "answered" && run.status !== "failed";
  const failed = !queued && run?.status === "failed";

  const messages = <ThreadMessages thread={thread} />;

  if (failed) {
    return (
      <article data-thread={thread.id} data-whole-artboard={wholeArtboardOf(thread)} className={cx(styles.card, styles.failed, thread.removed && styles.removed)}>
        <div className={styles.head}>
          <span className={cx(styles.badge, styles.badgeFailed, thread.removed && styles.badgeRemoved)}>{thread.number}</span>
          <span className={styles.where}>{threadWhere(thread)}</span>
          <RenderingChip thread={thread} />
          <span className={styles.spacer} />
          {thread.removed && <RemovedTag />}
          <span data-testid="run-status" data-status="failed" className={styles.headFailed}>
            Échec
          </span>
        </div>
        {run && <RunProgress run={run} />}
      </article>
    );
  }

  return (
    <article data-thread={thread.id} data-whole-artboard={wholeArtboardOf(thread)} className={cx(styles.card, active && styles.running, thread.removed && styles.removed)}>
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
        sessionLabel(session) && <span className={styles.sessionMeta}>{sessionLabel(session)}</span>
      ) : (
        <div className={cx(styles.footer, waitingForTerminal && styles.footerStacked)}>
          <SessionMeta session={session} />
          {!waitingForTerminal && <span className={styles.spacer} />}
          {!readOnly && (
            <div className={styles.footerActions}>
              {waitingForTerminal && (
                <Button size="sm" onClick={() => void fetch(`/api/threads/${thread.id}/hand-over`, { method: "POST" })}>
                  Confier à l'agent
                </Button>
              )}
              <Button size="sm" aria-expanded={replying} onClick={() => setReplying(!replying)}>
                Répondre
              </Button>
              {!thread.request && (
                <Button size="sm" variant="primary" onClick={onResolve}>
                  Résoudre
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {replying && !active && <ThreadReplyForm threadId={thread.id} choice={choice} onDone={() => setReplying(false)} />}
      <ContextLine thread={thread} />
    </article>
  );
}

/** The "Commentaires" tab: held bar, thread cards and the composer of a new pinned comment. */
export function CommentsPanel({ pageId, threads, queue, runs, sessions, defaults, choice, onChoice, draft, text, onText, onSend, onCancel, readOnly = false, archivedLabel = "Projet archivé", unfolded, onUnfold, onShowThread }: Props) {
  const ordered = [...threads].sort((a, b) => GROUP_ORDER[a.status] - GROUP_ORDER[b.status] || a.number - b.number);
  const heldCount = threads.filter((t) => t.status === "held").length;
  const listRef = useStickToBottom<HTMLDivElement>();

  // Picking an element (or the whole artboard) starts a draft: type right away.
  useEffect(() => {
    if (draft) document.getElementById("new-comment")?.focus();
  }, [draft]);

  return (
    <>
      <div
        ref={listRef}
        className={panel.list}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          // A control does its own job, and a drag that selects text is not a click on the card.
          if (target.closest("button, a, input, textarea, select, summary") || !window.getSelection()?.isCollapsed) return;
          const threadId = target.closest("[data-thread]")?.getAttribute("data-thread");
          if (threadId) onShowThread?.(threadId);
        }}
      >
        {!readOnly && <HeldBar pageId={pageId} count={heldCount} choice={choice} />}
        {ordered.map((thread) => {
          if (thread.status === "held") return <HeldThreadCard key={thread.id} thread={thread} />;
          if (thread.status === "resolved") return <ResolvedThreadCard key={thread.id} thread={thread} session={sessions.get(thread.id)} readOnly={readOnly} open={unfolded.has(thread.id)} onOpen={(open) => onUnfold(thread.id, open)} />;
          return (
            <ThreadCard
              key={thread.id}
              thread={thread}
              queued={queueLabel(queue, thread.id)}
              waitingForTerminal={queue.some((e) => e.reason === "terminal" && e.threadIds.includes(thread.id))}
              run={runs.filter((r) => r.threadIds.includes(thread.id)).slice(-1)[0]}
              session={sessions.get(thread.id)}
              choice={choice}
              onResolve={() => void fetch(`/api/threads/${thread.id}/resolve`, { method: "POST" })}
              readOnly={readOnly}
            />
          );
        })}
        {threads.length === 0 && (
          <p className={panel.empty}>{readOnly ? "Aucun commentaire sur cette page." : "Pas encore de commentaire. Passe en mode commentaire (C) et clique sur un élément."}</p>
        )}
      </div>
      {readOnly ? (
        <div className={panel.readOnlyNote}>{archivedLabel} : les fils se lisent mais on ne peut plus y répondre ni les résoudre.</div>
      ) : (
      <div className={panel.composer}>
        <label htmlFor="new-comment" className={panel.label}>
          Nouveau commentaire
        </label>
        {!draft ? (
          <p className={panel.hint}>
            Clique sur un élément en mode Commenter (C), ou ⌥ clic en mode Interagir, pour y épingler un commentaire.
          </p>
        ) : (
          <>
            <div className={panel.draft}>
              <span>
                Commentaire sur <code>{draft.label}</code>
              </span>
              <button type="button" className={panel.cancel} onClick={onCancel}>
                Annuler
              </button>
            </div>
            <Textarea
              id="new-comment"
              rows={3}
              className={panel.textarea}
              placeholder="Ton commentaire"
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
              <Button className={panel.action} aria-disabled={text.trim() === ""} title="Garde ce commentaire pour l'envoyer avec les autres (⌘ Entrée)" onClick={() => onSend(true)}>
                Plus tard
              </Button>
              <Button className={panel.action} variant="primary" aria-disabled={text.trim() === ""} title="Envoie ce commentaire tout de suite, seul (Entrée)" onClick={() => onSend(false)}>
                Envoyer
              </Button>
            </div>
          </>
        )}
        <ModelEffortControls value={choice} onChange={onChoice} defaults={defaults} />
      </div>
      )}
    </>
  );
}
