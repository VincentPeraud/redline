import { useCallback, useEffect, useState } from "react";
import type { SendHeldRequest, Thread, UpdateThreadRequest } from "@redline/shared";
import { ModelEffortControls, type ModelEffortChoice } from "./ModelEffortControls.js";
import { subscribeServerEvents } from "./serverEvents.js";

/** Bar "N en attente d'envoi · Tout envoyer": the held comments of the open page leave together, as one message. */
export function HeldBar({ pageId }: { pageId: string }) {
  const [count, setCount] = useState(0);
  const [choice, setChoice] = useState<ModelEffortChoice>({});

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/held`);
    setCount(((await res.json()) as Thread[]).length);
  }, [pageId]);

  useEffect(() => {
    void refresh();
    return subscribeServerEvents((event) => {
      if (event.type === "thread-updated" && event.pageId === pageId) void refresh();
    });
  }, [refresh, pageId]);

  async function sendAll() {
    const request: SendHeldRequest = choice;
    await fetch(`/api/pages/${pageId}/send-held`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    await refresh();
  }

  if (count === 0) return null;
  return (
    <div data-testid="held-bar" style={{ marginTop: 8, padding: 8, border: "1px dashed #8a6d00", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>{count} en attente d'envoi</span>
      <ModelEffortControls value={choice} onChange={setChoice} />
      <button onClick={() => void sendAll()}>Tout envoyer</button>
    </div>
  );
}

/** A held comment: dashed, labelled "En attente d'envoi", editable and deletable until it is sent. */
export function HeldThreadCard({ thread }: { thread: Thread }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(thread.body);

  async function save() {
    if (text.trim() === "") return;
    const request: UpdateThreadRequest = { body: text };
    await fetch(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setEditing(false);
  }

  return (
    <div data-testid="held-thread" style={{ border: "1px dashed #8a6d00", padding: 8, marginBottom: 8 }}>
      <strong>{thread.number}.</strong>{" "}
      {editing ? (
        <>
          <textarea aria-label="Modifier le commentaire" value={text} onChange={(e) => setText(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
          <button onClick={() => void save()}>Enregistrer</button>{" "}
          <button
            onClick={() => {
              setText(thread.body);
              setEditing(false);
            }}
          >
            Annuler
          </button>
        </>
      ) : (
        <>
          {thread.body}
          <div style={{ color: "#8a6d00", fontSize: 12 }}>En attente d'envoi</div>
          <button onClick={() => setEditing(true)}>Modifier</button>{" "}
          <button onClick={() => void fetch(`/api/threads/${thread.id}`, { method: "DELETE" })}>Supprimer</button>
        </>
      )}
    </div>
  );
}
