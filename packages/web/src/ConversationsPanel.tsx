import { useCallback, useEffect, useState } from "react";
import {
  CONTEXT_WARNING_PERCENT,
  type Conversation,
  type ConversationDetail,
  type CreateConversationMessageRequest,
  type QueueEntry,
  type ThreadRun,
} from "@redline/shared";
import { ModelEffortControls, type ModelEffortChoice } from "./ModelEffortControls.js";
import { workQueueLabel } from "./queueLabel.js";
import { RunProgress } from "./RunProgress.js";
import { subscribeServerEvents } from "./serverEvents.js";

const AGENT_DEFAULT = "défaut de l'agent";

/** "model · effort · context %" of a conversation, orange from 70 %. */
function SessionLine({ conversation }: { conversation: ConversationDetail }) {
  const percent = conversation.context?.percent;
  return (
    <div data-testid="conversation-session" style={{ fontSize: 12, color: percent !== undefined && percent >= CONTEXT_WARNING_PERCENT ? "#c2410c" : "#555" }}>
      {conversation.model ?? AGENT_DEFAULT} · {conversation.effort ?? AGENT_DEFAULT} · {percent === undefined ? "—" : `${percent} %`}
    </div>
  );
}

/** The page's conversations: create, switch, archive, and talk to Claude without a pin. */
export function ConversationsPanel({ pageId, runs, queue }: { pageId: string; runs: ThreadRun[]; queue: QueueEntry[] }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
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

  useEffect(() => {
    if (activeId) void refreshDetail(activeId);
    else setDetail(null);
  }, [activeId, refreshDetail]);

  async function create() {
    const res = await fetch(`/api/pages/${pageId}/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const created = (await res.json()) as ConversationDetail;
    await refreshList();
    setActiveId(created.id);
  }

  async function archive() {
    if (!activeId) return;
    await fetch(`/api/conversations/${activeId}/archive`, { method: "POST" });
    setActiveId(null);
    await refreshList();
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

  const run = detail ? runs.find((r) => r.workId === detail.runWorkId) : undefined;
  const queued = workQueueLabel(queue, detail?.runWorkId);

  return (
    <section data-testid="conversations" aria-label="Conversations">
      <h4>Conversations</h4>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <select aria-label="Conversation" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value || null)}>
          <option value="">{conversations.length === 0 ? "Aucune conversation" : "Choisir une conversation"}</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button onClick={() => void create()}>Nouvelle conversation</button>
        {activeId && <button onClick={() => void archive()}>Archiver</button>}
      </div>
      {detail && (
        <div style={{ border: "1px solid #ddd", padding: 8, marginTop: 8 }}>
          <SessionLine conversation={detail} />
          {detail.messages.map((m) => (
            <p key={m.id} data-testid="conversation-message" style={{ background: m.author === "user" ? "#fff" : "#f6f4ff", padding: 6, margin: "6px 0", whiteSpace: "pre-wrap" }}>
              <em>{m.author === "user" ? "You" : "Claude"}:</em> {m.body}
            </p>
          ))}
          {queued ? (
            <div data-testid="queued" style={{ color: "#8a6d00", fontSize: 12 }}>
              {queued}
            </div>
          ) : (
            run && <RunProgress run={run} />
          )}
          <textarea
            aria-label="Message"
            placeholder="Un retour général, un artboard à ajouter, une nouvelle page…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
          <ModelEffortControls value={choice} onChange={setChoice} />
          <button onClick={() => void send()}>Envoyer</button>
        </div>
      )}
    </section>
  );
}
