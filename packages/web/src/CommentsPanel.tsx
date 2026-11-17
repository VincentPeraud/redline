import { Fragment, useEffect, useState, type ReactNode } from "react";
import { INSTANCE_TAG_PREFIX, requestIsOpen, type CommentMode, type QueueEntry, type SessionRow, type Thread, type ThreadRun } from "@redline/shared";
import { CreatedPageCards } from "./CreatedPageCards.js";
import { ContextLine } from "./ContextLine.js";
import { RemovedTag } from "./RemovedTag.js";
import { HeldBar, HeldThreadCard } from "./HeldComments.js";
import { ReviewBar, sendToClaude } from "./ReviewComments.js";
import { MessageAuthor } from "./MessageAuthor.js";
import { ModelEffortControls, type AgentDefaults, type ModelEffortChoice } from "./ModelEffortControls.js";
import { InstanceThreadInfo } from "./InstanceThreads.js";
import { RenderingChip } from "./RenderingChip.js";
import { DESIGN_SYSTEM_CLAUDE, RequestOrigins, RequestStatePill, RequestTag, requestAskerName } from "./RequestThreads.js";
import { queueLabel, waitingForOfflineAgent } from "./queueLabel.js";
import { relativeTime } from "./relativeTime.js";
import { RunProgress } from "./RunProgress.js";
import { shortSessionId } from "./sessionLabel.js";
import { AgentWaitBlock, HandlerStatus, ReviewNoteBlock, TakenBlock, useHandler } from "./ThreadTake.js";
import { CommentModeHint } from "./CommentMode.js";
import { threadWhere, wholeArtboardOf } from "./threadLabel.js";
import { useStickToBottom } from "./useStickToBottom.js";
import { RefuseDialog, refuseRequestTarget } from "./RefuseDialog.js";
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
  /** `held`: "Brouillon", keeps the comment, for its author only, until "Tout envoyer". */
  onSend: (held: boolean) => void;
  onCancel: () => void;
  /** An archived project's (or archived) page: threads are read, none is added, answered or resolved. */
  readOnly?: boolean;
  /** What is archived, opening the read-only note: "Projet archivé" (default) or "Page archivée". */
  archivedLabel?: string;
  /** The viewer comments but does not work (Commentaire level): no "Tout envoyer" bar, which is Écriture. */
  commentOnly?: boolean;
  /** The line at the top saying where the page's comments go; absent where the page has no comment mode (design system, archived). */
  modeHint?: { mode: CommentMode; canWork: boolean };
  pageTitle?: string;
  /** Resolved threads unfolded in the list: their pins show again on the canvas. */
  unfolded: ReadonlySet<string>;
  onUnfold: (threadId: string, open: boolean) => void;
  /** A click on a thread's card (not on one of its controls): the canvas goes to where the comment is. */
  onShowThread?: (threadId: string) => void;
  /** A thread was resolved or reopened here: the list loads again at once, without waiting for the server event. */
  onThreadsChanged?: () => void;
}

const GROUP_ORDER: Record<Thread["status"], number> = { held: 0, review: 1, open: 2, resolved: 3 };

/** Where an À relire comment comes from, next to its author: the link it was written through, or the member's level. */
const reviewAside = (thread: Thread): string | undefined =>
  thread.linkAuthor ? (thread.linkAuthor.linkName ? `lien « ${thread.linkAuthor.linkName} »` : "lien en Commentaire") : thread.person ? "membre en Commentaire" : undefined;

function ThreadHeader({ thread, waitingForAgent, children }: { thread: Thread; waitingForAgent: boolean; children?: ReactNode }) {
  return (
    <>
      <div className={styles.head}>
        <span className={cx(styles.badge, thread.removed && styles.badgeRemoved)}>{thread.number}</span>
        <span className={styles.where}>{threadWhere(thread)}</span>
        <RenderingChip thread={thread} />
        <span className={styles.spacer} />
        {thread.removed && <RemovedTag />}
        {thread.request && <RequestTag />}
        {thread.status === "review" && (
          <span data-testid="review-status" className={cx(styles.status, styles.statusWait)}>
            À relire
          </span>
        )}
        {thread.status === "open" && <HandlerStatus thread={thread} />}
        {waitingForAgent && (
          <span data-testid="queued" className={cx(styles.status, styles.statusWait)}>
            En attente de l'agent (hors ligne)
          </span>
        )}
        {thread.status === "open" && thread.replies.at(-1)?.author === "redline" && <span data-testid="reopened" className={styles.reopened}>rouvert</span>}
        {children}
      </div>
      {thread.request && (
        <>
          <RequestStatePill request={thread.request} />
          <RequestOrigins request={thread.request} />
        </>
      )}
      <InstanceThreadInfo thread={thread} />
    </>
  );
}

/** "session 7c2e…a91" for a thread an agent session handles. */
function sessionLabel(session: SessionRow | undefined): string | undefined {
  return session?.sessionId ? `session ${shortSessionId(session.sessionId)}` : undefined;
}

/** "session 7c2e…a91" over "il y a 2 min", in a card's footer. */
function SessionMeta({ session, createdAt }: { session: SessionRow | undefined; createdAt?: string }) {
  return (
    <span className={styles.sessionMeta}>
      {sessionLabel(session) && (
        <>
          {sessionLabel(session)}
          <br />
        </>
      )}
      {session ? relativeTime(session.activityAt) : createdAt && relativeTime(createdAt)}
    </span>
  );
}

/** The comment and its replies, as the card of an open or a resolved thread shows them. */
function ThreadMessages({ thread }: { thread: Thread }) {
  return (
    <>
      <div className={styles.message}>
        <MessageAuthor person={thread.person} linkAuthor={thread.linkAuthor} claude={requestAskerName(thread)} redline={thread.automatic} aside={thread.status === "review" ? reviewAside(thread) : undefined} />
        {thread.fromReviewAt && <span className={styles.reviewNote}>depuis la revue du {new Date(thread.fromReviewAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span>}
        {thread.body}
      </div>
      {thread.replies.map((reply) => (
        <Fragment key={reply.id}>
          <div data-testid="reply" className={cx(styles.message, reply.author === "claude" && styles.claudeReply, reply.author === "redline" && styles.redlineReply)}>
            {reply.author === "user" ? (
              <MessageAuthor person={reply.person} linkAuthor={reply.linkAuthor} />
            ) : reply.author === "redline" ? (
              <MessageAuthor redline />
            ) : (
              <MessageAuthor claude={thread.request ? DESIGN_SYSTEM_CLAUDE : true} conversation={reply.conversation} />
            )}
            {reply.body}
          </div>
          <CreatedPageCards pages={reply.createdPages} />
        </Fragment>
      ))}
    </>
  );
}

/** A resolved thread: one line, which unfolds the discussion read-only, with "Rouvrir" to put it back among the open threads. */
function ResolvedThreadCard({ thread, session, readOnly, open, onOpen, onReopen }: { thread: Thread; session: SessionRow | undefined; readOnly: boolean; open: boolean; onOpen: (open: boolean) => void; onReopen: () => void }) {
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
          <InstanceThreadInfo thread={thread} />
          <ThreadMessages thread={thread} />
          <div className={styles.footer}>
            <SessionMeta session={session} />
            <span className={styles.spacer} />
            {!readOnly && (
              <Button size="sm" onClick={onReopen}>
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
  queue,
  queued,
  run,
  session,
  choice,
  onResolve,
  onSend,
  readOnly,
}: {
  thread: Thread;
  queue: QueueEntry[];
  queued: string | undefined;
  run: ThreadRun | undefined;
  session: SessionRow | undefined;
  choice: ModelEffortChoice;
  /** "Résoudre": absent where the viewer only comments (Commentaire). */
  onResolve?: () => void;
  /** "Envoyer à Claude", for an "À relire" thread: absent where the viewer does not work (Commentaire). */
  onSend?: () => void;
  readOnly: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const active = !queued && run !== undefined && run.status !== "answered" && run.status !== "failed";
  const failed = !queued && run?.status === "failed";
  const handler = useHandler(thread);
  const waitingForAgent = waitingForOfflineAgent(queue, thread.id) && !session?.sessionId;
  const stacked = handler !== undefined || waitingForAgent || thread.status === "review";

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
        <InstanceThreadInfo thread={thread} />
        {run && <RunProgress run={run} />}
      </article>
    );
  }

  return (
    <article data-thread={thread.id} data-whole-artboard={wholeArtboardOf(thread)} className={cx(styles.card, active && styles.running, handler?.kind === "taken" && !handler.mine && !handler.relaunch && styles.takenOther, thread.removed && styles.removed)}>
      <ThreadHeader thread={thread} waitingForAgent={waitingForAgent}>
        {queued && !waitingForAgent && (
          <span data-testid="queued" className={styles.queued}>
            {queued}
          </span>
        )}
      </ThreadHeader>
      {messages}
      <TakenBlock thread={thread} />
      {waitingForAgent && <AgentWaitBlock />}
      {thread.status === "review" && <ReviewNoteBlock />}
      {run && !queued && <RunProgress run={run} />}
      {active ? (
        sessionLabel(session) && <span className={styles.sessionMeta}>{sessionLabel(session)}</span>
      ) : (
        <div className={cx(styles.footer, stacked && styles.footerStacked)}>
          <SessionMeta session={session} createdAt={thread.createdAt} />
          {!stacked && <span className={styles.spacer} />}
          {!readOnly && (
            <div className={styles.footerActions}>
              <Button size="sm" aria-expanded={replying} onClick={() => setReplying(!replying)}>
                Répondre
              </Button>
              {thread.request && requestIsOpen(thread.request) && (
                <Button size="sm" onClick={() => setRefusing(true)}>
                  Refuser
                </Button>
              )}
              {!thread.request && onResolve && (
                <Button size="sm" variant={thread.status === "review" ? undefined : "primary"} onClick={onResolve}>
                  Résoudre
                </Button>
              )}
              {thread.status === "review" && onSend && (
                <Button size="sm" variant="primary" onClick={onSend}>
                  Envoyer à Claude
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {replying && !active && <ThreadReplyForm threadId={thread.id} choice={choice} onDone={() => setReplying(false)} />}
      <ContextLine thread={thread} />
      {refusing && thread.request && <RefuseDialog target={refuseRequestTarget(thread.id, `${INSTANCE_TAG_PREFIX}${thread.request.component}`)} onClose={() => setRefusing(false)} onRefused={() => undefined} />}
    </article>
  );
}

/** The "Commentaires" tab: held bar, thread cards and the composer of a new pinned comment. */
export function CommentsPanel({ pageId, threads, queue, runs, sessions, defaults, choice, onChoice, draft, text, onText, onSend, onCancel, readOnly = false, commentOnly = false, archivedLabel = "Projet archivé", modeHint, pageTitle = "", unfolded, onUnfold, onShowThread, onThreadsChanged }: Props) {
  // The list follows the answer itself: behind a proxy that holds the event stream back, the click would otherwise seem to do nothing.
  const act = (threadId: string, action: "resolve" | "reopen") =>
    void fetch(`/api/threads/${threadId}/${action}`, { method: "POST" }).then((res) => {
      if (res.ok) onThreadsChanged?.();
    });
  const ordered = [...threads].sort((a, b) => GROUP_ORDER[a.status] - GROUP_ORDER[b.status] || a.number - b.number);
  const heldCount = threads.filter((t) => t.status === "held").length;
  const reviewCount = threads.filter((t) => t.status === "review").length;
  const listRef = useStickToBottom<HTMLDivElement>();

  // Picking an element (or the whole artboard) starts a draft: type right away.
  useEffect(() => {
    if (draft) document.getElementById("new-comment")?.focus();
  }, [draft]);

  return (
    <>
      {!readOnly && <HeldBar pageId={pageId} count={heldCount} choice={choice} sentAs={commentOnly ? "review" : (modeHint?.mode ?? "agent")} />}
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
        {modeHint && <CommentModeHint mode={modeHint.mode} toTake={threads.filter((thread) => thread.toTake).length} canWork={modeHint.canWork} pageTitle={pageTitle} />}
        {!readOnly && <ReviewBar pageId={pageId} count={reviewCount} choice={choice} canSend={!commentOnly} />}
        {ordered.map((thread) => {
          if (thread.status === "held") return <HeldThreadCard key={thread.id} thread={thread} />;
          if (thread.status === "resolved") return <ResolvedThreadCard key={thread.id} thread={thread} session={sessions.get(thread.id)} readOnly={readOnly || commentOnly} open={unfolded.has(thread.id)} onOpen={(open) => onUnfold(thread.id, open)} onReopen={() => act(thread.id, "reopen")} />;
          return (
            <ThreadCard
              key={thread.id}
              thread={thread}
              queue={queue}
              queued={queueLabel(queue, thread.id)}
              run={runs.filter((r) => r.threadIds.includes(thread.id)).slice(-1)[0]}
              session={sessions.get(thread.id)}
              choice={choice}
              onResolve={commentOnly ? undefined : () => act(thread.id, "resolve")}
              onSend={commentOnly ? undefined : () => void sendToClaude(pageId, choice, [thread.id])}
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
              {!commentOnly && (
                <Button className={panel.action} aria-disabled={text.trim() === ""} title="Garde ce commentaire en brouillon, à toi seul, pour l'envoyer avec les autres (⌘ Entrée)" onClick={() => onSend(true)}>
                  Brouillon
                </Button>
              )}
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
