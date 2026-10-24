import { useCallback, useEffect, useRef, useState } from "react";
import {
  MANIFEST_PATH,
  defaultManifest,
  parseManifest,
  versionPreviewPath,
  type AgentInfo,
  type CreateThreadRequest,
  type Manifest,
  type Project,
  type QueueEntry,
  type Thread,
} from "@redline/shared";
import { ArtboardFrame, type Pick } from "./ArtboardFrame.js";
import { ArtboardHistory } from "./ArtboardHistory.js";
import { restoreArtboard, useDeletedArtboards } from "./restoreArtboard.js";
import { UndoToast } from "./UndoToast.js";
import { CanvasHeader } from "./CanvasHeader.js";
import { useGuidesVisible } from "./useGuidesVisible.js";
import { panBy, zoomAt, type CanvasView } from "./canvasView.js";
import { CanvasElements } from "./CanvasElements.js";
import { CommentsPanel, type Draft } from "./CommentsPanel.js";
import { ConversationsPanel } from "./ConversationsPanel.js";
import type { AgentDefaults, ModelEffortChoice } from "./ModelEffortControls.js";
import { PlayMode } from "./PlayMode.js";
import { TweaksPanel } from "./TweaksPanel.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { cx } from "./ui/index.js";
import { usePageSessions } from "./usePageSessions.js";
import { useRuns } from "./useRuns.js";
import { useTweaks } from "./useTweaks.js";
import styles from "./PageCanvas.module.css";

const ZOOM_STEP = 1.25;
/** Where the artboards start on screen at the initial view: left margin, and room above for the group title and artboard labels. */
const START_LEFT = 80;
const START_TOP = 190;
const START_BOTTOM = 40;

type SideTab = "conversation" | "comments";

function boundsOf(boxes: { x: number; y: number; width: number; height: number }[]) {
  if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: Math.max(right - left, 1), height: Math.max(bottom - top, 1) };
}

/** Initial view: artboards at 100 % under the group titles, shrunk when they would not fit the stage height. */
function initialView(manifest: Manifest, stage: { width: number; height: number }): CanvasView {
  const bounds = boundsOf(manifest.artboards.map((a) => ({ x: a.x, y: a.y, width: a.width, height: a.height })));
  const zoom = Math.min(1, (stage.height - START_TOP - START_BOTTOM) / bounds.height);
  return { zoom, x: START_LEFT - bounds.x * zoom, y: START_TOP - bounds.y * zoom };
}

function GuidesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

interface Props {
  pageId: string;
  pageTitle: string;
  project: Project | null;
  /** Path -> content hash of the current version. */
  files: Record<string, string>;
  artboardOrigin: string;
  versionId: string;
  /** Called after the page got a new version from this canvas (a saved tweak). */
  onVersionChange: () => void;
}

export function PageCanvas({ pageId, pageTitle, project, files, artboardOrigin, versionId, onVersionChange }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<(Pick & { artboard: string }) | null>(null);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelEffortChoice>({});
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>({});
  const [tab, setTab] = useState<SideTab>("conversation");
  const [tweaksOpenFor, setTweaksOpenFor] = useState<string | null>(null);
  /** Bumped when the page's design system changed: artboards remount to load the new tokens. */
  const [tokensVersion, setTokensVersion] = useState(0);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [playFrom, setPlayFrom] = useState<string | null>(null);
  const [historyOpenFor, setHistoryOpenFor] = useState<string | null>(null);
  /** An old version shown in place of one artboard, read-only, until restored or cancelled. */
  const [preview, setPreview] = useState<{ file: string; versionId: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; undo: () => Promise<void> } | null>(null);
  const deleted = useDeletedArtboards(pageId, versionId);
  const [guidesVisible, toggleGuides] = useGuidesVisible();
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, zoom: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const runs = useRuns(pageId);
  const sessions = usePageSessions(pageId);
  const tweaks = useTweaks(pageId, manifest, files, onVersionChange);
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
        const rect = viewport.current?.getBoundingClientRect();
        if (!placed.current && rect) {
          placed.current = true;
          setView(initialView(next, rect));
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
  }, [playFrom]);

  function zoomFromCenter(factor: number) {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    setView((v) => zoomAt(v, factor, { x: rect.width / 2, y: rect.height / 2 }));
  }

  const servingAgentId = project?.servedBy?.id ?? project?.agent?.id;
  useEffect(() => {
    if (!servingAgentId) return;
    void fetch("/api/agents")
      .then((res) => res.json() as Promise<AgentInfo[]>)
      .then((agents) => {
        const agent = agents.find((a) => a.id === servingAgentId);
        setAgentDefaults({ model: agent?.model, effort: agent?.effort });
      });
  }, [servingAgentId]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/threads`);
    setThreads((await res.json()) as Thread[]);
  }, [pageId]);

  const refreshQueue = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/queue`);
    setQueue((await res.json()) as QueueEntry[]);
  }, [pageId]);

  useEffect(() => {
    void refresh();
    void refreshQueue();
    return subscribeServerEvents((event) => {
      if (event.type === "thread-updated" && event.pageId === pageId) void refresh();
      if (event.type === "queue-updated" && event.pageId === pageId) void refreshQueue();
      if (event.type === "design-system-updated" && event.pageIds.includes(pageId)) setTokensVersion((v) => v + 1);
    });
  }, [refresh, refreshQueue, pageId]);

  // C: comment mode, P: back to interactive, G: layout guides.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (playFrom !== null || target.tagName === "TEXTAREA" || target.tagName === "INPUT" || event.metaKey || event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "c") setPicking(true);
      if (key === "p") setPicking(false);
      if (key === "g") toggleGuides();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGuides, playFrom]);

  /** "Envoyer" sends the comment now; "Plus tard" (`held`) keeps it on the server until "Tout envoyer". */
  async function send(held: boolean) {
    if (!draft || text.trim() === "") return;
    const request: CreateThreadRequest = { ...draft, body: text, ...(held ? { held } : choice) };
    await fetch(`/api/pages/${pageId}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setDraft(null);
    setText("");
    await refresh();
  }

  /** Restores one artboard (history or deleted list) and offers to undo it for a few seconds. */
  async function restore(file: string, restoreVersionId: string) {
    const { version, previousVersionId } = await restoreArtboard(pageId, file, restoreVersionId);
    setPreview(null);
    setHistoryOpenFor(null);
    setToast({
      message: version.message,
      undo: async () => {
        await restoreArtboard(pageId, file, previousVersionId);
        onVersionChange();
      },
    });
    onVersionChange();
  }

  async function renamePage(title: string) {
    const res = await fetch(`/api/pages/${pageId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error(`Rename refused (${res.status})`);
    onVersionChange();
  }

  if (playFrom !== null && manifest) {
    return (
      <PlayMode
        pageId={pageId}
        manifest={manifest}
        start={playFrom}
        artboardOrigin={artboardOrigin}
        tweaks={tweaks.values}
        onTweak={tweaks.setValue}
        guidesVisible={guidesVisible}
        onToggleGuides={toggleGuides}
        onExit={() => setPlayFrom(null)}
      />
    );
  }

  const openCount = threads.filter((t) => t.status !== "resolved").length;
  const runningCount = runs.filter((r) => r.status === "running" || r.status === "sent" || r.status === "retrying").length;
  const firstArtboard = manifest?.artboards[0]?.file;
  const draftInfo: Draft | null = draft;
  const artboardTweaks = (file: string) => (manifest?.tweaks ?? []).filter((tweak) => (tweak.artboard ? tweak.artboard === file : file === firstArtboard));

  return (
    <div className={styles.page}>
      <CanvasHeader
        project={project}
        pageId={pageId}
        pageTitle={pageTitle}
        picking={picking}
        onPickingChange={setPicking}
        runningCount={runningCount}
        artboardOrigin={artboardOrigin}
        deleted={deleted}
        onPutBack={(item) => restore(item.file, item.lastVersionId)}
        onRenamePage={renamePage}
      />
      <div className={styles.body}>
        <main className={styles.stage}>
          {manifestError && <div role="alert" className={styles.error}>{manifestError}</div>}
          <div
            ref={viewport}
            data-testid="canvas"
            data-canvas-viewport
            className={styles.viewport}
            style={{ backgroundPosition: `${view.x}px ${view.y}px` }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button, a, [data-no-pan]")) return;
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
            <div className={styles.world} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
              {manifest && <CanvasElements elements={manifest.elements} artboards={manifest.artboards} assetBase={`${artboardOrigin}/pages/${pageId}`} artboardOrigin={artboardOrigin} />}
              {manifest?.artboards.map((artboard) => (
                <div
                  key={`${artboard.file}@${files[artboard.file]}@${tokensVersion}`}
                  className={cx(styles.artboard, (historyOpenFor === artboard.file || tweaksOpenFor === artboard.file) && styles.artboardRaised)}
                  style={{ left: artboard.x, top: artboard.y }}
                >
                  <div data-no-pan className={styles.label} style={{ width: artboard.width * view.zoom, transform: `scale(${1 / view.zoom})` }}>
                    <span className={styles.labelName}>{artboard.title ?? artboard.file}</span>
                    <span className={styles.spacer} />
                    <ArtboardHistory
                      pageId={pageId}
                      file={artboard.file}
                      pageVersionId={versionId}
                      open={historyOpenFor === artboard.file}
                      onOpenChange={(open) => setHistoryOpenFor(open ? artboard.file : null)}
                      previewVersionId={preview?.file === artboard.file ? preview.versionId : null}
                      onPreview={(previewId) => setPreview(previewId ? { file: artboard.file, versionId: previewId } : null)}
                      onRestore={(restoreId) => restore(artboard.file, restoreId)}
                    />
                    {artboardTweaks(artboard.file).length > 0 && (
                      <button type="button" aria-expanded={tweaksOpenFor === artboard.file} className={styles.tweaksButton} onClick={() => setTweaksOpenFor(tweaksOpenFor === artboard.file ? null : artboard.file)}>
                        Tweaks
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Lancer ${artboard.file} en plein écran`}
                      title="Plein écran"
                      className={styles.iconButton}
                      onClick={() => setPlayFrom(artboard.file)}
                    >
                      <FullscreenIcon />
                    </button>
                  </div>
                  <ArtboardFrame
                    key={preview?.file === artboard.file ? preview.versionId : "live"}
                    title={`${pageTitle} / ${artboard.file}`}
                    src={
                      preview?.file === artboard.file
                        ? `${artboardOrigin}${versionPreviewPath(pageId, preview.versionId, artboard.file)}`
                        : `${artboardOrigin}/pages/${pageId}/${artboard.file}`
                    }
                    width={artboard.width}
                    height={artboard.height}
                    zoom={view.zoom}
                    guides={guidesVisible ? artboard.guides : undefined}
                    threads={preview?.file === artboard.file ? [] : threads.filter((t) => t.artboard === artboard.file)}
                    picking={picking && preview?.file !== artboard.file}
                    tweaks={tweaks.values}
                    onPick={(pick) => {
                      setDraft({ ...pick, artboard: artboard.file });
                      setTab("comments");
                    }}
                  />
                  {tweaksOpenFor === artboard.file && (
                    <div
                      data-no-pan
                      role="dialog"
                      aria-label={`Tweaks de ${artboard.file}`}
                      className={styles.tweaksPopover}
                      style={{ left: artboard.width + 12, transform: `scale(${1 / view.zoom})` }}
                    >
                      <div className={styles.popoverHead}>
                        <span className={styles.popoverTitle}>Tweaks · {artboard.file.replace(/\.html$/, "")}</span>
                        <span className={styles.spacer} />
                        <button type="button" aria-label="Fermer les tweaks" className={styles.popoverClose} onClick={() => setTweaksOpenFor(null)}>
                          ×
                        </button>
                      </div>
                      <TweaksPanel tweaks={artboardTweaks(artboard.file)} values={tweaks.values} onChange={tweaks.setValue} previews={{ pageId, artboardOrigin, artboard }} />
                      <div className={styles.popoverHint}>
                        Le choix fait partie du design : il est enregistré avec l'artefact et s'applique ici comme en mode play.
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          {manifest?.artboards.length === 0 && (
            <div className={styles.emptyWrap}>
              <div data-testid="canvas-empty" className={styles.empty}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="3" width="16" height="18" rx="2" />
                  <path d="M12 9v6" />
                  <path d="M9 12h6" />
                </svg>
                <h2 className={styles.emptyTitle}>Cette page est vide</h2>
                <p className={styles.emptyText}>Demande à Claude d'y ajouter des artboards dans le panneau Conversations, ou depuis ton terminal.</p>
              </div>
            </div>
          )}
          <div className={styles.hintWrap}>
            <div data-testid="mode-indicator" className={cx(styles.hint, picking && styles.hintComment)}>
              {picking ? "Mode commentaire : clique sur un élément pour y épingler un commentaire" : "Canvas interactif : les clics déclenchent les actions. Alt+clic pour commenter."}
            </div>
          </div>
          {toast && (
            <UndoToast
              message={toast.message}
              onUndo={() => {
                void toast.undo().then(() => setToast(null));
              }}
              onExpire={() => setToast(null)}
            />
          )}
          <div className={styles.zoom}>
            <button type="button" aria-label="Dézoomer" className={styles.zoomButton} onClick={() => zoomFromCenter(1 / ZOOM_STEP)}>
              −
            </button>
            <span className={styles.zoomValue}>{Math.round(view.zoom * 100)} %</span>
            <button type="button" aria-label="Zoomer" className={styles.zoomButton} onClick={() => zoomFromCenter(ZOOM_STEP)}>
              +
            </button>
            <span aria-hidden="true" className={styles.zoomSeparator} />
            <button type="button" aria-pressed={guidesVisible} title="Afficher les guides de mise en page (G)" className={cx(styles.guidesButton, guidesVisible && styles.guidesButtonOn)} onClick={toggleGuides}>
              <GuidesIcon />
              Guides (G)
            </button>
          </div>
        </main>

        <aside aria-label="Commentaires" className={styles.aside}>
          <div role="tablist" aria-label="Panneau latéral" className={styles.tabs}>
            <button type="button" role="tab" aria-selected={tab === "conversation"} className={cx(styles.tab, tab === "conversation" && styles.tabActive)} onClick={() => setTab("conversation")}>
              Conversation
            </button>
            <button type="button" role="tab" aria-selected={tab === "comments"} className={cx(styles.tab, tab === "comments" && styles.tabActive)} onClick={() => setTab("comments")}>
              Commentaires · {openCount}
            </button>
          </div>
          {tab === "conversation" ? (
            <ConversationsPanel pageId={pageId} pageTitle={pageTitle} artboardCount={manifest?.artboards.length ?? 0} runs={runs} queue={queue} sessions={sessions} defaults={agentDefaults} />
          ) : (
            <CommentsPanel
              pageId={pageId}
              threads={threads}
              queue={queue}
              runs={runs}
              sessions={sessions}
              defaults={agentDefaults}
              choice={choice}
              onChoice={setChoice}
              draft={draftInfo}
              text={text}
              onText={setText}
              onSend={(held) => void send(held)}
              onCancel={() => {
                setDraft(null);
                setText("");
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
