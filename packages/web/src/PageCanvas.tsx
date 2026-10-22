import { useCallback, useEffect, useState } from "react";
import type { CreateThreadRequest, Thread } from "@redline/shared";
import { ArtboardFrame, type Pick } from "./ArtboardFrame.js";

interface Props {
  pageId: string;
  pageTitle: string;
  artboards: string[];
  artboardOrigin: string;
  versionId: string;
}

export function PageCanvas({ pageId, pageTitle, artboards, artboardOrigin, versionId }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<(Pick & { artboard: string }) | null>(null);
  const [text, setText] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/threads`);
    setThreads((await res.json()) as Thread[]);
  }, [pageId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // C: comment mode, P: back to interactive.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || event.metaKey || event.ctrlKey) return;
      if (event.key === "c") setPicking(true);
      if (event.key === "p") setPicking(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function send() {
    if (!draft || text.trim() === "") return;
    const request: CreateThreadRequest = { ...draft, body: text };
    await fetch(`/api/pages/${pageId}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setDraft(null);
    setText("");
    setPicking(false);
    await refresh();
  }

  async function resolve(thread: Thread) {
    await fetch(`/api/threads/${thread.id}/resolve`, { method: "POST" });
    await refresh();
  }

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      <div>
        <div style={{ marginBottom: 8 }}>
          <button onClick={() => setPicking(!picking)}>{picking ? "Comment mode (P to leave)" : "Interactive (C to comment)"}</button>
        </div>
        {artboards.map((path) => (
          <ArtboardFrame
            key={`${path}@${versionId}`}
            title={`${pageTitle} / ${path}`}
            src={`${artboardOrigin}/pages/${pageId}/${path}`}
            threads={threads.filter((t) => t.artboard === path)}
            picking={picking}
            onPick={(pick) => setDraft({ ...pick, artboard: path })}
          />
        ))}
        {draft && (
          <div style={{ marginTop: 8 }}>
            <div>
              Comment on <code>{draft.selector}</code>
            </div>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={3}
              style={{ width: 400 }}
            />
            <div>
              <button onClick={() => void send()}>Send</button>{" "}
              <button
                onClick={() => {
                  setDraft(null);
                  setText("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <aside style={{ width: 280 }}>
        <h4>Threads</h4>
        {threads.map((thread) =>
          thread.status === "resolved" ? (
            <div key={thread.id} style={{ color: "#888", padding: "4px 0" }}>
              {thread.number}. <s>{thread.title}</s> (resolved)
            </div>
          ) : (
            <div key={thread.id} style={{ border: "1px solid #ddd", padding: 8, marginBottom: 8 }}>
              <strong>{thread.number}.</strong> {thread.body}
              <div>
                <button onClick={() => void resolve(thread)}>Resolve</button>
              </div>
            </div>
          ),
        )}
      </aside>
    </div>
  );
}
