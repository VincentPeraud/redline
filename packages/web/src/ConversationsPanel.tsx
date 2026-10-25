import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  CONTEXT_WARNING_PERCENT,
  type Conversation,
  type ConversationDetail,
  type CreateConversationMessageRequest,
  type MessageContext,
  type QueueEntry,
  type SessionRow,
  type ThreadTarget,
  type ThreadRun,
} from "@redline/shared";
import { ModelEffortControls, type AgentDefaults, type ModelEffortChoice } from "./ModelEffortControls.js";
import { contextChips } from "./messageContext.js";
import { workQueueLabel } from "./queueLabel.js";
import { CreatedPageCards } from "./CreatedPageCards.js";
import { PendingDiffusionCard } from "./PendingDiffusionCard.js";
import { activityLabel } from "./sessionsView.js";
import { RunProgress } from "./RunProgress.js";
import { shortSessionId } from "./sessionLabel.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { ElementChip } from "./ElementChip.js";
import { AddressPill, PlainLink } from "./AddressPill.js";
import { splitMessageLinks } from "./messageLinks.js";
import { rememberArtboardTitles } from "./otherPageArtboards.js";
import { Button, Textarea, Tooltip, cx } from "./ui/index.js";
import styles from "./ConversationsPanel.module.css";

const AGENT_DEFAULT = "défaut de l'agent";

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

/** "model · effort · context %" of a conversation, orange from 70 %. */
function SessionLine({ conversation }: { conversation: ConversationDetail }) {
  const percent = conversation.context?.percent;
  const warn = percent !== undefined && percent >= CONTEXT_WARNING_PERCENT;
  return (
    <div data-testid="conversation-session" className={cx(styles.sessionLine, warn && styles.sessionWarn)}>
      {conversation.model ?? AGENT_DEFAULT} · {conversation.effort ?? AGENT_DEFAULT} · {percent === undefined ? "—" : `${percent} %`}
    </div>
  );
}

/** A conversation to bring up, `nonce` making a second request for the same one act again. */
export interface FocusedConversation {
  id: string;
  nonce: number;
}

interface Props {
  pageId: string;
  pageTitle: string;
  /** Version of the page: a run publishes after storing its answer, so the conversation reloads when it changes. */
  versionId: string;
  artboardCount: number;
  /** Artboards of the page, to title the pills that point at them; null until the manifest is known. */
  artboards: { file: string; title: string }[] | null;
  /** Centres the canvas on an artboard (a pill of this page). */
  onCenterArtboard: (file: string) => void;
  /** Shows "Cet artboard n'existe plus" (a pill whose artboard is gone). */
  onMissingArtboard: (file: string) => void;
  /** Shown as soon as it changes: the conversation that just received a message posted from outside the panel. */
  focusedConversation: FocusedConversation | null;
  /** What goes with the next message, live with the canvas view and the tweaks. */
  context: MessageContext;
  runs: ThreadRun[];
  queue: QueueEntry[];
  sessions: Map<string, SessionRow>;
  defaults: AgentDefaults;
  /** Elements the user points at for the next message; they live above this panel so they survive a tab switch. */
  chips: ThreadTarget[];
  selecting: boolean;
  onSelectingChange: (selecting: boolean) => void;
  onRemoveChip: (index: number) => void;
  /** Called once the message is sent: the chips and their marks go. */
  onChipsSent: () => void;
}

/** The "Conversation" tab: the page's conversations (create, switch, archive) and talking to Claude without a pin. */
export function ConversationsPanel({ pageId, pageTitle, versionId, artboardCount, artboards, onCenterArtboard, onMissingArtboard, focusedConversation, context, runs, queue, sessions, defaults, chips, selecting, onSelectingChange, onRemoveChip, onChipsSent }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** `activeId` as of now, not as of the last render: a message sent right after "+ Nouvelle" must land in the conversation just created. */
  const activeRef = useRef<string | null>(null);
  const creating = useRef<Promise<string> | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelEffortChoice>({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/conversations`);
    const list = ((await res.json()) as Conversation[]).filter((c) => !c.archived);
    setConversations(list.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)));
  }, [pageId]);

  const refreshDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/conversations/${id}`);
    setDetail((await res.json()) as ConversationDetail);
  }, []);

  useEffect(() => {
    void refreshList();
    return subscribeServerEvents((event) => {
      if (event.type !== "conversation-updated" || event.pageId !== pageId) return;
      void refreshList();
      setActiveId((current) => {
        if (current === event.conversationId) void refreshDetail(current);
        return current;
      });
    });
  }, [pageId, refreshList, refreshDetail]);

  const showConversation = (id: string | null) => {
    activeRef.current = id;
    setActiveId(id);
  };

  useEffect(() => {
    if (!focusedConversation) return;
    showConversation(focusedConversation.id);
    void refreshList();
  }, [focusedConversation, refreshList]);

  // Open the most recent conversation once the list is known.
  useEffect(() => {
    if (activeRef.current === null && conversations[0]) showConversation(conversations[0].id);
  }, [conversations]);

  useEffect(() => {
    if (activeId) void refreshDetail(activeId);
    else setDetail(null);
  }, [activeId, versionId, refreshDetail]);

  /** One creation at a time: a message sent while "+ Nouvelle" is still in flight joins it instead of creating a second conversation. */
  function createConversation(): Promise<string> {
    creating.current ??= fetch(`/api/pages/${pageId}/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(async (res) => {
        if (!res.ok) throw new Error("conversation");
        const { id } = (await res.json()) as ConversationDetail;
        showConversation(id);
        return id;
      })
      .finally(() => {
        creating.current = null;
      });
    return creating.current;
  }

  async function create() {
    await createConversation();
    await refreshList();
    setListOpen(false);
  }

  async function archive(id: string) {
    await fetch(`/api/conversations/${id}/archive`, { method: "POST" });
    const rest = conversations.filter((c) => c.id !== id);
    setConversations(rest);
    if (activeId === id) showConversation(rest[0]?.id ?? null);
  }

  /** Keeps the text and chips when anything fails: they only go once the message is stored. */
  async function send() {
    if (text.trim() === "" || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const request: CreateConversationMessageRequest = { body: text, context: chips.length > 0 ? { ...context, targets: chips } : context, ...choice };
      const conversationId = activeRef.current ?? (await createConversation());
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error("message");
      setText("");
      onChipsSent();
    } catch {
      setSendError("Le message n'a pas été envoyé. Ton texte est conservé, réessaie.");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (artboards) rememberArtboardTitles(pageId, artboards.map((a) => [a.file, a.title]));
  }, [pageId, artboards]);

  const current = { id: pageId, title: pageTitle, artboards };
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const lastRun = detail ? runs.find((r) => r.workId === detail.runWorkId) : undefined;
  const run = lastRun?.status === "answered" ? undefined : lastRun;
  const queued = workQueueLabel(queue, detail?.runWorkId);
  const lastDesignSystemAnswer = [...(detail?.messages ?? [])].reverse().find((m) => m.designSystemId)?.id;
  const sessionId = activeId ? sessions.get(activeId)?.sessionId : undefined;

  return (
    <section data-testid="conversations" aria-label="Conversations" className={styles.panel}>
      <div className={styles.toolbar}>
        <button
          type="button"
          aria-label="Conversation"
          aria-haspopup="listbox"
          aria-expanded={listOpen}
          className={styles.picker}
          onClick={() => setListOpen(!listOpen)}
        >
          <span className={cx(styles.pickerTitle, !active && styles.pickerPlaceholder)}>{active ? active.title : "Aucune conversation"}</span>
          <span className={styles.spacer} />
          <span aria-hidden="true" className={styles.chevron}>
            ▼
          </span>
        </button>
        <Button variant="accent" className={styles.newButton} onClick={() => void create()}>
          + Nouvelle
        </Button>
        <Tooltip label="Supprimer cette conversation">
          <button
            type="button"
            aria-label="Supprimer cette conversation"
            className={styles.iconButton}
            disabled={!active}
            onClick={() => active && void archive(active.id)}
          >
            <TrashIcon />
          </button>
        </Tooltip>
        {listOpen && (
          <div role="listbox" aria-label="Conversations de la page" className={styles.list}>
            <div className={styles.listTitle}>Conversations · {pageTitle}</div>
            {conversations.map((c) => (
              <div key={c.id} className={cx(styles.option, c.id === activeId && styles.optionSelected)}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.id === activeId}
                  className={styles.optionMain}
                  onClick={() => {
                    showConversation(c.id);
                    setListOpen(false);
                  }}
                >
                  <span className={styles.optionTitle}>{c.title}</span>
                  <span className={styles.optionMeta}>
                    {c.exchangeCount} {c.exchangeCount === 1 ? "échange" : "échanges"} · {activityLabel(c.lastActivityAt)}
                  </span>
                </button>
                <Tooltip label={`Supprimer la conversation ${c.title}`}>
                  <button type="button" aria-label={`Supprimer la conversation ${c.title}`} className={styles.optionDelete} onClick={() => void archive(c.id)}>
                    <TrashIcon />
                  </button>
                </Tooltip>
              </div>
            ))}
            {conversations.length === 0 && <div className={styles.listEmpty}>Aucune conversation sur cette page.</div>}
          </div>
        )}
      </div>

      <div className={styles.context}>
        <span className={styles.contextLabel}>Contexte transmis</span>
        <div className={styles.chips}>
          {contextChips(pageTitle, artboardCount, context).map((chip) => (
            <span key={chip} className={styles.chip}>
              {chip}
            </span>
          ))}
        </div>
      </div>

      {detail && detail.messages.length > 0 ? (
        <div className={styles.messages}>
          {detail.messages.map((m) =>
            m.author === "user" ? (
              <div key={m.id} className={styles.userMessage}>
                {m.targets && m.targets.length > 0 && (
                  <div data-testid="message-chips" className={styles.messageChips}>
                    {m.targets.map((target, i) => (
                      <ElementChip key={i} number={i + 1} target={target} />
                    ))}
                  </div>
                )}
                <div data-testid="conversation-message" className={styles.userBubble}>
                  {m.body}
                </div>
              </div>
            ) : (
              <Fragment key={m.id}>
                <div data-testid="conversation-message" className={styles.claudeMessage}>
                  <span className={styles.author}>Claude</span> —{" "}
                  {splitMessageLinks(m.body, window.location.origin).map((segment, i) =>
                    segment.kind === "text" ? (
                      <Fragment key={i}>{segment.text}</Fragment>
                    ) : segment.kind === "link" ? (
                      <PlainLink key={i} url={segment.url} />
                    ) : (
                      <AddressPill key={i} address={segment} current={current} onCenter={onCenterArtboard} onMissing={onMissingArtboard} />
                    ),
                  )}
                </div>
                <CreatedPageCards pages={m.createdPages} />
                {m.designSystemId && m.id === lastDesignSystemAnswer && <PendingDiffusionCard designSystemId={m.designSystemId} refreshKey={versionId} />}
              </Fragment>
            ),
          )}
          {queued ? (
            <div data-testid="queued" className={styles.queued}>
              {queued}
            </div>
          ) : (
            run && <RunProgress run={run} label="Claude travaille…" />
          )}
        </div>
      ) : (
        <div className={styles.empty}>
          {detail ? (
            <>
              <div className={styles.emptyTitle}>Nouvelle conversation</div>
              <div className={styles.emptyText}>Claude connaît la page affichée. Demande un retour général, un artboard ou une nouvelle page.</div>
              {queued ? (
                <div data-testid="queued" className={styles.queued}>
                  {queued}
                </div>
              ) : (
                run && <RunProgress run={run} label="Claude travaille…" />
              )}
            </>
          ) : (
            <>
              <div className={styles.emptyTitle}>Nouvelle conversation</div>
              <div className={styles.emptyText}>Écris ton premier message : la conversation est créée à l'envoi.</div>
            </>
          )}
        </div>
      )}

      <div className={styles.composer}>
        <label htmlFor="conversation-message" className={styles.label}>
          Message à Claude
        </label>
        <div className={styles.messageBox}>
          {chips.length > 0 && (
            <div className={styles.messageBoxChips}>
              {chips.map((target, i) => (
                <ElementChip key={i} number={i + 1} target={target} onRemove={() => onRemoveChip(i)} />
              ))}
            </div>
          )}
          <Textarea
            id="conversation-message"
            className={styles.messageInput}
            rows={chips.length > 0 ? 2 : 3}
            placeholder="Un retour général, un artboard à ajouter, une nouvelle page…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </div>
        {sendError && (
          <div role="alert" className={styles.error}>
            {sendError}
          </div>
        )}
        <div className={styles.actions}>
          <button type="button" aria-pressed={selecting} className={cx(styles.elementButton, selecting && styles.elementButtonOn)} onClick={() => onSelectingChange(!selecting)}>
            + Élément
          </button>
          {selecting && <span className={styles.selectingNote}>mode sélection actif</span>}
          <span className={styles.spacer} />
          <Button variant="primary" className={styles.sendButton} disabled={text.trim() === "" || sending} onClick={() => void send()}>
            Envoyer
          </Button>
        </div>
        <ModelEffortControls value={choice} onChange={setChoice} defaults={defaults} />
        {detail && detail.context && detail.context.percent >= CONTEXT_WARNING_PERCENT && <SessionLine conversation={detail} />}
        <div className={styles.sessionId}>{sessionId ? `session ${shortSessionId(sessionId)}` : "aucune session"} · séparée des fils de commentaires</div>
      </div>
    </section>
  );
}
