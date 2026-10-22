import { useCallback, useEffect, useState } from "react";
import {
  CONTEXT_WARNING_PERCENT,
  type Conversation,
  type ConversationDetail,
  type CreateConversationMessageRequest,
  type QueueEntry,
  type SessionRow,
  type ThreadRun,
} from "@redline/shared";
import { ModelEffortControls, type ModelEffortChoice } from "./ModelEffortControls.js";
import { workQueueLabel } from "./queueLabel.js";
import { relativeTime } from "./relativeTime.js";
import { RunProgress } from "./RunProgress.js";
import { shortSessionId } from "./sessionLabel.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { Button, Textarea, cx } from "./ui/index.js";
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

interface Props {
  pageId: string;
  pageTitle: string;
  artboardCount: number;
  runs: ThreadRun[];
  queue: QueueEntry[];
  sessions: Map<string, SessionRow>;
}

/** The "Conversation" tab: the page's conversations (create, switch, archive) and talking to Claude without a pin. */
export function ConversationsPanel({ pageId, pageTitle, artboardCount, runs, queue, sessions }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelEffortChoice>({});

  const refreshList = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/conversations`);
    setConversations(((await res.json()) as Conversation[]).filter((c) => !c.archived));
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

  // Open the most recent conversation once the list is known.
  useEffect(() => {
    setActiveId((current) => current ?? conversations[0]?.id ?? null);
  }, [conversations]);

  useEffect(() => {
    if (activeId) void refreshDetail(activeId);
    else setDetail(null);
  }, [activeId, refreshDetail]);

  async function create() {
    const res = await fetch(`/api/pages/${pageId}/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const created = (await res.json()) as ConversationDetail;
    await refreshList();
    setActiveId(created.id);
    setListOpen(false);
  }

  async function archive(id: string) {
    await fetch(`/api/conversations/${id}/archive`, { method: "POST" });
    const rest = conversations.filter((c) => c.id !== id);
    setConversations(rest);
    if (activeId === id) setActiveId(rest[0]?.id ?? null);
  }

  async function send() {
    if (!activeId || text.trim() === "") return;
    const request: CreateConversationMessageRequest = { body: text, ...choice };
    await fetch(`/api/conversations/${activeId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setText("");
  }

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const lastRun = detail ? runs.find((r) => r.workId === detail.runWorkId) : undefined;
  const run = lastRun?.status === "answered" ? undefined : lastRun;
  const queued = workQueueLabel(queue, detail?.runWorkId);
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
          <span className={styles.pickerTitle}>{active ? active.title : "Aucune conversation"}</span>
          <span className={styles.spacer} />
          <span aria-hidden="true" className={styles.chevron}>
            ▼
          </span>
        </button>
        <Button variant="accent" className={styles.newButton} onClick={() => void create()}>
          + Nouvelle
        </Button>
        <button
          type="button"
          aria-label="Supprimer cette conversation"
          className={styles.iconButton}
          disabled={!active}
          onClick={() => active && void archive(active.id)}
        >
          <TrashIcon />
        </button>
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
                    setActiveId(c.id);
                    setListOpen(false);
                  }}
                >
                  <span className={styles.optionTitle}>{c.title}</span>
                  <span className={styles.optionMeta}>{relativeTime(c.createdAt)}</span>
                </button>
                <button type="button" aria-label={`Supprimer la conversation ${c.title}`} className={styles.optionDelete} onClick={() => void archive(c.id)}>
                  <TrashIcon />
                </button>
              </div>
            ))}
            {conversations.length === 0 && <div className={styles.listEmpty}>Aucune conversation sur cette page.</div>}
          </div>
        )}
      </div>

      <div className={styles.context}>
        <span className={styles.contextLabel}>Contexte transmis</span>
        <span className={styles.chip}>{pageTitle}</span>
        <span className={styles.chip}>
          {artboardCount} {artboardCount > 1 ? "artboards" : "artboard"}
        </span>
      </div>

      {detail && detail.messages.length > 0 ? (
        <div className={styles.messages}>
          {detail.messages.map((m) =>
            m.author === "user" ? (
              <div key={m.id} data-testid="conversation-message" className={styles.userBubble}>
                {m.body}
              </div>
            ) : (
              <div key={m.id} data-testid="conversation-message" className={styles.claudeMessage}>
                <span className={styles.author}>Claude</span> — {m.body}
              </div>
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
              <div className={styles.emptyTitle}>Aucune conversation</div>
              <div className={styles.emptyText}>Clique sur « + Nouvelle » pour en ouvrir une.</div>
            </>
          )}
        </div>
      )}

      <div className={styles.composer}>
        <label htmlFor="conversation-message" className={styles.label}>
          Message à Claude
        </label>
        <Textarea
          id="conversation-message"
          rows={3}
          placeholder="Un retour général, un artboard à ajouter, une nouvelle page…"
          disabled={!activeId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <ModelEffortControls value={choice} onChange={setChoice} />
        {detail && <SessionLine conversation={detail} />}
        <div className={styles.sessionId}>{sessionId ? `session ${shortSessionId(sessionId)}` : "aucune session"} · séparée des fils de commentaires</div>
      </div>
    </section>
  );
}
