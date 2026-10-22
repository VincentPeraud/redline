import { useCallback, useEffect, useRef, useState } from "react";
import {
  MANIFEST_PATH,
  defaultManifest,
  parseManifest,
  type CreateThreadRequest,
  type Manifest,
  type Thread,
} from "@redline/shared";
import { ArtboardFrame, type Pick } from "./ArtboardFrame.js";
import { fitView, panBy, zoomAt, type CanvasView } from "./canvasView.js";
import { PlayMode } from "./PlayMode.js";

const CANVAS_HEIGHT = 520;
const ZOOM_STEP = 1.25;
const START_MARGIN = 48;

function manifestBounds(manifest: Manifest) {
  const boxes = [
    ...manifest.artboards.map((a) => ({ x: a.x, y: a.y, width: a.width, height: a.height })),
    ...manifest.notes.map((n) => ({ x: n.x, y: n.y, width: 0, height: 0 })),
  ];
  if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: Math.max(right - left, 1), height: Math.max(bottom - top, 1) };
}

interface Props {
  pageId: string;
  pageTitle: string;
  /** Path -> content hash of the current version. */
  files: Record<string, string>;
  artboardOrigin: string;
  versionId: string;
}

export function PageCanvas({ pageId, pageTitle, files, artboardOrigin, versionId }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<(Pick & { artboard: string }) | null>(null);
  const [text, setText] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, zoom: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const hasManifest = MANIFEST_PATH in files;
  const htmlPaths = Object.keys(files).filter((path) => path.endsWith(".html"));
  const pathsKey = htmlPaths.join("\n");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let next: Manifest;
        if (hasManifest) {
          const res = await fetch(`/api/pages/${pageId}/files/${MANIFEST_PATH}`);
          next = parseManifest(await res.text());
        } else {
          next = defaultManifest(pathsKey === "" ? [] : pathsKey.split("\n"));
        }
        if (cancelled) return;
        setManifestError(null);
        setManifest(next);
        if (!placed.current) {
          placed.current = true;
          const bounds = manifestBounds(next);
          setView({ zoom: 1, x: START_MARGIN - bounds.x, y: START_MARGIN - bounds.y });
        }
      } catch (error) {
        if (!cancelled) setManifestError((error as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [pageId, versionId, hasManifest, pathsKey]);

  // Wheel: pan, or zoom around the cursor with ctrl/cmd (also pinch on trackpads). Needs a non-passive listener.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = element!.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        setView((v) => zoomAt(v, Math.exp(-event.deltaY * 0.01), cursor));
      } else {
        setView((v) => panBy(v, -event.deltaX, -event.deltaY));
      }
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  function zoomFromCenter(factor: number) {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    setView((v) => zoomAt(v, factor, { x: rect.width / 2, y: rect.height / 2 }));
  }

  function fit() {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || !manifest) return;
    setView(fitView(manifestBounds(manifest), rect));
  }

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
      const key = event.key.toLowerCase();
      if (key === "c") setPicking(true);
      if (key === "p") setPicking(false);
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
    await refresh();
  }

  async function resolve(thread: Thread) {
    await fetch(`/api/threads/${thread.id}/resolve`, { method: "POST" });
    await refresh();
  }

  if (playing && manifest) {
    return <PlayMode pageId={pageId} manifest={manifest} artboardOrigin={artboardOrigin} onExit={() => setPlaying(false)} />;
  }

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setPicking(!picking)}>{picking ? "Comment mode (P to leave)" : "Interactive (C to comment)"}</button>
          <button aria-label="Zoom out" onClick={() => zoomFromCenter(1 / ZOOM_STEP)}>
            -
          </button>
          <span>{Math.round(view.zoom * 100)}%</span>
          <button aria-label="Zoom in" onClick={() => zoomFromCenter(ZOOM_STEP)}>
            +
          </button>
          <button onClick={fit}>Fit</button>
          <button onClick={() => setPlaying(true)} disabled={!manifest}>
            Play
          </button>
        </div>
        {manifestError && <div role="alert">{manifestError}</div>}
        <div
          ref={viewport}
          data-testid="canvas"
          style={{ position: "relative", height: CANVAS_HEIGHT, overflow: "hidden", background: "#f2f2f0", cursor: "grab", touchAction: "none" }}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const dx = e.clientX - drag.current.x;
            const dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            setView((v) => panBy(v, dx, dy));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <div
            data-testid="mode-indicator"
            style={{
              position: "absolute",
              right: 8,
              top: 8,
              zIndex: 1,
              padding: "2px 8px",
              borderRadius: 4,
              font: "600 12px system-ui",
              pointerEvents: "none",
              background: picking ? "#e5484d" : "#222",
              color: "#fff",
            }}
          >
            {picking ? "Comment mode (P to interact)" : "Interactive (C to comment, Alt+click to pin)"}
          </div>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transformOrigin: "0 0",
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            }}
          >
            {manifest?.notes.map((note, i) => (
              <div key={i} style={{ position: "absolute", left: note.x, top: note.y, whiteSpace: "nowrap", font: "600 20px system-ui" }}>
                {note.text}
              </div>
            ))}
            {manifest?.artboards.map((artboard) => (
              <div key={`${artboard.file}@${versionId}`} style={{ position: "absolute", left: artboard.x, top: artboard.y }}>
                <div style={{ position: "absolute", bottom: "100%", font: "12px system-ui", color: "#666", whiteSpace: "nowrap" }}>
                  {artboard.title ?? artboard.file}
                </div>
                <ArtboardFrame
                  title={`${pageTitle} / ${artboard.file}`}
                  src={`${artboardOrigin}/pages/${pageId}/${artboard.file}`}
                  width={artboard.width}
                  height={artboard.height}
                  zoom={view.zoom}
                  threads={threads.filter((t) => t.artboard === artboard.file)}
                  picking={picking}
                  onPick={(pick) => setDraft({ ...pick, artboard: artboard.file })}
                />
              </div>
            ))}
          </div>
        </div>
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
