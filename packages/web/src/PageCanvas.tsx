import { useAltKey } from "./useAltKey.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_VIEW_SETTINGS,
  MANIFEST_PATH,
  RESPONSIVE_FORMATS,
  defaultManifest,
  parseManifest,
  readingOrder,
  versionPreviewPath,
  type AgentInfo,
  type CreateThreadRequest,
  canvasElementSummary,
  threadTargetLabel,
  type Manifest,
  type ManifestElementKind,
  type PageViewSettings,
  type ResponsiveFormat,
  type Project,
  type QueueEntry,
  type Thread,
  type ThreadRendering,
  type ThreadTarget,
} from "@redline/shared";
import { ArtboardFrame, type Pick } from "./ArtboardFrame.js";
import { ArtboardHistory } from "./ArtboardHistory.js";
import { restoreArtboard, useDeletedArtboards } from "./restoreArtboard.js";
import { UndoToast } from "./UndoToast.js";
import { CanvasHeader } from "./CanvasHeader.js";
import { useStoredToggle } from "./useStoredToggle.js";
import { GuidesButton } from "./GuidesButton.js";
import { isEditableTarget } from "./isEditableTarget.js";
import { centerOn, panBy, zoomAt, type CanvasView } from "./canvasView.js";
import { COPIED_BUBBLE_MS, copyAddress } from "./copyLink.js";
import { TocList } from "./TocList.js";
import { artboardAtCentre, type TocItem } from "./tocItems.js";
import { CanvasElements } from "./CanvasElements.js";
import { responsiveFrameLayout, renderingSlots, type Box } from "./canvasGeometry.js";
import { ResponsiveFrame } from "./ResponsiveFrame.js";
import { RenderingChips, RenderingsMenu } from "./RenderingControls.js";
import { hiddenRenderingKeys, hiddenThreadCounts, setFormatShown, toggleRendering } from "./viewSettings.js";
import { CommentsPanel, type Draft } from "./CommentsPanel.js";
import { ConversationsPanel } from "./ConversationsPanel.js";
import type { AgentDefaults, ModelEffortChoice } from "./ModelEffortControls.js";
import { PlayMode } from "./PlayMode.js";
import { addChip, marksFor, removeChip } from "./elementChips.js";
import { messageContext } from "./messageContext.js";
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
/** Pointer travel (screen pixels) under which a press and release count as a click. */
const CLICK_SLOP = 4;

type SideTab = "conversation" | "comments" | "toc";

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

const OUTLINE_MS = 2000;

function CopyLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

function BubbleIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}

/** A comment being written: pinned on an element of an artboard, or on a whole artboard. */
type PageDraft =
  | (Pick & { artboard: string; rendering?: ThreadRendering })
  | { target: { kind: "artboard"; artboard: string } }
  | { target: { kind: "canvas-element"; elementId: string; elementKind: ManifestElementKind } };

/** The part of a create-thread request that says where the comment goes (the server fills the kind of a canvas element). */
function threadPlace(draft: PageDraft) {
  if (!("target" in draft)) return draft;
  return draft.target.kind === "canvas-element" ? { target: { kind: "canvas-element" as const, elementId: draft.target.elementId } } : { target: draft.target };
}

function draftLabel(draft: PageDraft): string {
  return "target" in draft ? threadTargetLabel(draft.target) : (draft.elementName ?? draft.selector);
}

function FullscreenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
  /** The page's view settings as the server has them. */
  viewSettings?: PageViewSettings;
  /** File named by an artboard address (`.../artboards/<file>`): the canvas centres and outlines it once. */
  addressedArtboard?: string;
}

export function PageCanvas({ pageId, pageTitle, project, files, artboardOrigin, versionId, onVersionChange, viewSettings: savedViewSettings, addressedArtboard }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [picking, setPicking] = useState(false);
  const alt = useAltKey();
  /** The conversation's selection mode ("+ Élément"), exclusive with comment mode. */
  const [selecting, setSelecting] = useState(false);
  /** Elements the user points at for the next conversation message, numbered by position. */
  const [chips, setChips] = useState<ThreadTarget[]>([]);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelEffortChoice>({});
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>({});
  const [tab, setTab] = useState<SideTab>("conversation");
  /** Artboard whose whole-artboard threads the Commentaires tab scrolls to once shown. */
  const [scrollToArtboard, setScrollToArtboard] = useState<string | null>(null);
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
  const [guidesVisible, toggleGuides] = useStoredToggle("redline:guides", false);
  /** Real page height of each rendering of a responsive artboard, by artboard file then rendering key, as reported by the bridge. */
  const [docHeights, setDocHeights] = useState<Record<string, Record<string, number>>>({});
  const [viewSettings, setViewSettings] = useState<PageViewSettings>(savedViewSettings ?? EMPTY_VIEW_SETTINGS);
  const [renderingsMenuOpen, setRenderingsMenuOpen] = useState(false);
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, zoom: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const placed = useRef(false);
  /** Artboard outlined for a moment after an address centred on it. */
  const [outlined, setOutlined] = useState<string | null>(null);
  /** File of an address that names an artboard the manifest no longer has. */
  const [missingArtboard, setMissingArtboard] = useState<string | null>(null);
  /** Strip whose "Lien copié" bubble is up; `at` restarts the timer on a second copy. */
  const [copied, setCopied] = useState<{ file: string; at: number } | null>(null);
  const artboardBoxesRef = useRef<Map<string, Box>>(new Map());
  const handledAddress = useRef<string | undefined>(undefined);
  const drag = useRef<{ x: number; y: number } | null>(null);
  /** Where the pointer went down, to tell a click on a canvas element from the end of a pan. */
  const pressedAt = useRef<{ x: number; y: number } | null>(null);

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

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [playFrom]);

  // An artboard address acts once per address, after the manifest and the viewport are known; panning and zooming never touch the URL.
  useEffect(() => {
    if (addressedArtboard === undefined) {
      handledAddress.current = undefined;
      return;
    }
    if (!manifest || viewportSize.width === 0 || handledAddress.current === addressedArtboard) return;
    handledAddress.current = addressedArtboard;
    const box = artboardBoxesRef.current.get(addressedArtboard);
    if (!box) {
      setMissingArtboard(addressedArtboard);
      setOutlined(null);
      return;
    }
    setMissingArtboard(null);
    setView(centerOn(box, viewportSize));
    setOutlined(addressedArtboard);
  }, [addressedArtboard, manifest, viewportSize]);

  useEffect(() => {
    if (outlined === null) return;
    const timer = setTimeout(() => setOutlined(null), OUTLINE_MS);
    return () => clearTimeout(timer);
  }, [outlined]);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_BUBBLE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  function copyArtboardLink(file: string) {
    void copyAddress({ name: "page", pageId, artboard: file }).then(() => setCopied({ file, at: Date.now() }));
  }

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

  // "Removed" is derived from the current manifest, so a new version can change it.
  useEffect(() => {
    void refresh();
  }, [refresh, versionId]);

  useEffect(() => {
    if (scrollToArtboard === null || tab !== "comments") return;
    document.querySelector(`[data-whole-artboard="${CSS.escape(scrollToArtboard)}"]`)?.scrollIntoView({ block: "nearest" });
    setScrollToArtboard(null);
  }, [scrollToArtboard, tab, threads]);

  useEffect(() => {
    if (!selecting) return;
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSelecting(false);
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [selecting]);

  // C: comment mode, P: back to interactive, G: layout guides.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (playFrom !== null || isEditableTarget(event.target) || event.metaKey || event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        setPicking(true);
        setSelecting(false);
      }
      if (key === "p") setPicking(false);
      if (key === "g") toggleGuides();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGuides, playFrom]);

  /** "Envoyer" sends the comment now; "Plus tard" (`held`) keeps it on the server until "Tout envoyer". */
  async function send(held: boolean) {
    if (!draft || text.trim() === "") return;
    const request: CreateThreadRequest = { ...threadPlace(draft), body: text, ...(held ? { held } : choice) };
    await fetch(`/api/pages/${pageId}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setDraft(null);
    setText("");
    await refresh();
  }

  /** View settings are per page and live on the server; they are not a version and no session hears of them. */
  function changeViewSettings(next: PageViewSettings) {
    setViewSettings(next);
    void fetch(`/api/pages/${pageId}/view-settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
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

  function changeSelecting(next: boolean) {
    setSelecting(next);
    if (next) setPicking(false);
  }

  const pickElement = (pick: Pick, artboard: string, rendering?: ThreadRendering) =>
    setChips((current) => addChip(current, { kind: "element", artboard, selector: pick.selector, elementName: pick.elementName ?? null, xPct: pick.xPct, yPct: pick.yPct, ...(rendering && { rendering }) }));

  async function renamePage(title: string) {
    const res = await fetch(`/api/pages/${pageId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error(`Rename refused (${res.status})`);
    onVersionChange();
  }

  if (playFrom !== null && manifest) {
    return (
      <PlayMode
        pageId={pageId}
        pageTitle={pageTitle}
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
  const draftInfo: Draft | null = draft && { label: draftLabel(draft) };
  const pinnedOn = (file: string) => threads.filter((t) => t.target.kind === "element" && t.artboard === file);
  const wholeArtboardThreads = (file: string) => threads.filter((t) => t.target.kind === "artboard" && t.artboard === file && t.status !== "resolved");
  const hiddenOf = (artboard: Manifest["artboards"][number]) => (artboard.responsive ? hiddenRenderingKeys(artboard.responsive, viewSettings, artboard.file) : new Set<string>());
  const layoutOf = (artboard: Manifest["artboards"][number]) =>
    artboard.responsive ? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive), { measuredHeights: docHeights[artboard.file], hidden: hiddenOf(artboard) }) : null;
  const responsiveArtboards = (manifest?.artboards ?? []).filter((artboard) => artboard.responsive);
  const formatsOnPage = (Object.keys(RESPONSIVE_FORMATS) as ResponsiveFormat[])
    .map((format) => ({ format, frames: responsiveArtboards.filter((a) => a.responsive!.some((r) => r.format === format)).length }))
    .filter(({ frames }) => frames > 0);
  const artboardBoxes = new Map<string, Box>(
    (manifest?.artboards ?? []).map((artboard) => [artboard.file, layoutOf(artboard)?.frame ?? { x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height }]),
  );
  artboardBoxesRef.current = artboardBoxes;
  const tocItems: TocItem[] = readingOrder(
    (manifest?.artboards ?? []).map((artboard) => ({ file: artboard.file, title: artboard.title, ...artboardBoxes.get(artboard.file)! })),
    (manifest?.elements ?? []).flatMap((element) => (element.kind === "title" ? [{ text: element.text, x: element.x, y: element.y, width: element.width }] : [])),
  ).map((entry) => ({ ...entry, openThreads: threads.filter((t) => t.artboard === entry.file && t.status !== "resolved").length }));
  const currentTocFile = artboardAtCentre(
    [...artboardBoxes].map(([file, box]) => ({ file, ...box })),
    view,
    viewportSize,
  );
  function centerOnArtboard(file: string) {
    const box = artboardBoxes.get(file);
    if (!box) return;
    setView((v) => ({ ...v, x: viewportSize.width / 2 - (box.x + box.width / 2) * v.zoom, y: viewportSize.height / 2 - (box.y + box.height / 2) * v.zoom }));
  }
  const conversationContext = messageContext({ view, viewport: viewportSize, boxes: artboardBoxes, manifest, tweakValues: tweaks.values });
  const artboardTweaks = (file: string) => (manifest?.tweaks ?? []).filter((tweak) => (tweak.artboard ? tweak.artboard === file : file === firstArtboard));

  const canvasMarks = chips.flatMap((chip, index) => (chip.kind === "canvas-element" ? [{ number: index + 1, elementId: chip.elementId }] : []));

  return (
    <div className={styles.page}>
      <CanvasHeader
        project={project}
        pageId={pageId}
        pageTitle={pageTitle}
        picking={picking}
        onPickingChange={(next) => {
          setPicking(next);
          if (next) setSelecting(false);
        }}
        runningCount={runningCount}
        artboardOrigin={artboardOrigin}
        deleted={deleted}
        onPutBack={(item) => restore(item.file, item.lastVersionId)}
        onRenamePage={renamePage}
        toc={{ items: tocItems, currentFile: currentTocFile, onSelect: centerOnArtboard }}
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
              pressedAt.current = { x: e.clientX, y: e.clientY };
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
            onPointerUp={(e) => {
              drag.current = null;
              const pressed = pressedAt.current;
              pressedAt.current = null;
              if ((picking || selecting || e.altKey) && manifest && pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < CLICK_SLOP) {
                const id = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-canvas-element-id]")?.getAttribute("data-canvas-element-id");
                const element = manifest.elements.find((candidate) => candidate.id === id);
                if (element?.id !== undefined && selecting) {
                  setChips((current) => addChip(current, { kind: "canvas-element", elementId: element.id!, elementKind: element.kind, elementSummary: canvasElementSummary(element) }));
                } else if (element?.id !== undefined) {
                  setDraft({ target: { kind: "canvas-element", elementId: element.id, elementKind: element.kind } });
                  setTab("comments");
                }
              }
            }}
          >
            <div className={styles.world} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
              {manifest && (
              <CanvasElements elements={manifest.elements} artboardBoxes={artboardBoxes} assetBase={`${artboardOrigin}/pages/${pageId}`} artboardOrigin={artboardOrigin} picking={picking || selecting || alt} zoom={view.zoom} threads={threads} marks={canvasMarks}>
              {manifest.artboards.map((artboard) => {
                const layout = layoutOf(artboard);
                const hidden = hiddenOf(artboard);
                const frameWidth = artboardBoxes.get(artboard.file)!.width;
                const src =
                  preview?.file === artboard.file
                    ? `${artboardOrigin}${versionPreviewPath(pageId, preview.versionId, artboard.file)}`
                    : `${artboardOrigin}/pages/${pageId}/${artboard.file}`;
                return (
                <div
                  key={`${artboard.file}@${files[artboard.file]}@${tokensVersion}`}
                  data-artboard={artboard.file}
                  className={cx(styles.artboard, (historyOpenFor === artboard.file || tweaksOpenFor === artboard.file) && styles.artboardRaised)}
                  style={{ left: artboard.x, top: artboard.y }}
                >
                  <div
                    data-no-pan
                    data-strip={artboard.file}
                    className={cx(styles.label, layout && styles.labelResponsive, selecting && styles.labelSelecting)}
                    style={{ width: frameWidth * view.zoom, transform: `scale(${1 / view.zoom})` }}
                    onClick={(e) => {
                      if (selecting && !(e.target as HTMLElement).closest("button")) setChips((current) => addChip(current, { kind: "artboard", artboard: artboard.file }));
                    }}
                  >
                    {chips.map((chip, index) =>
                      chip.kind === "artboard" && chip.artboard === artboard.file ? (
                        <span key={index} data-strip-mark={index + 1} className={styles.stripMark}>
                          {index + 1}
                        </span>
                      ) : null,
                    )}
                    {copied?.file === artboard.file && (
                      <div role="status" className={styles.copiedBubble}>
                        Lien copié
                      </div>
                    )}
                    <span className={cx(styles.labelName, outlined === artboard.file && styles.labelNameOutlined)}>{artboard.title ?? artboard.file}</span>
                    {layout && artboard.responsive && (
                      <>
                        <span className={styles.responsiveBadge}>responsive</span>
                        <RenderingChips
                          renderings={artboard.responsive}
                          hidden={hidden}
                          hiddenThreadCounts={hiddenThreadCounts(threads, artboard.file, hidden)}
                          onToggle={(key) => changeViewSettings(toggleRendering(viewSettings, artboard.file, artboard.responsive!, key))}
                        />
                      </>
                    )}
                    {wholeArtboardThreads(artboard.file).length > 0 && (
                      <button
                        type="button"
                        className={styles.threadsChip}
                        onClick={() => {
                          setTab("comments");
                          setScrollToArtboard(artboard.file);
                        }}
                      >
                        <BubbleIcon size={12} />
                        {wholeArtboardThreads(artboard.file).length === 1 ? "1 fil" : `${wholeArtboardThreads(artboard.file).length} fils`} sur l'artboard
                      </button>
                    )}
                    <span className={styles.spacer} />
                    <button
                      type="button"
                      aria-label={`Commenter tout ${artboard.file}`}
                      title="Commenter l'artboard entier"
                      className={styles.iconButton}
                      onClick={() => {
                        setDraft({ target: { kind: "artboard", artboard: artboard.file } });
                        setTab("comments");
                      }}
                    >
                      <BubbleIcon size={13} />
                    </button>
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
                      aria-label={`Copier le lien de ${artboard.file}`}
                      title={`Copier le lien de ${artboard.file}`}
                      className={styles.iconButton}
                      onClick={() => copyArtboardLink(artboard.file)}
                    >
                      <CopyLinkIcon />
                    </button>
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
                  {outlined === artboard.file && (
                    <span
                      data-artboard-outline
                      className={styles.artboardOutline}
                      style={{ width: frameWidth * view.zoom, height: artboardBoxes.get(artboard.file)!.height * view.zoom, transform: `scale(${1 / view.zoom})` }}
                    />
                  )}
                  {layout && artboard.responsive ? (
                    <ResponsiveFrame
                      key={preview?.file === artboard.file ? preview.versionId : "live"}
                      title={`${pageTitle} / ${artboard.file}`}
                      src={src}
                      renderings={artboard.responsive}
                      layout={layout}
                      zoom={view.zoom}
                      guides={guidesVisible ? artboard.guides : undefined}
                      threads={preview?.file === artboard.file ? [] : pinnedOn(artboard.file)}
                      picking={picking && preview?.file !== artboard.file}
                      selecting={selecting && preview?.file !== artboard.file}
                      marksOf={(key) => marksFor(chips, artboard.file, key)}
                      tweaks={tweaks.values}
                      onPick={(rendering, pick) => {
                        const where = { format: rendering.format, width: rendering.width };
                        if (selecting) return pickElement(pick, artboard.file, where);
                        setDraft({ ...pick, artboard: artboard.file, rendering: where });
                        setTab("comments");
                      }}
                      onEscape={() => setSelecting(false)}
                      onDocHeight={(key, height) =>
                        setDocHeights((current) => (current[artboard.file]?.[key] === height ? current : { ...current, [artboard.file]: { ...current[artboard.file], [key]: height } }))
                      }
                    />
                  ) : (
                  <ArtboardFrame
                    key={preview?.file === artboard.file ? preview.versionId : "live"}
                    title={`${pageTitle} / ${artboard.file}`}
                    src={src}
                    width={artboard.width}
                    height={artboard.height}
                    zoom={view.zoom}
                    guides={guidesVisible ? artboard.guides : undefined}
                    threads={preview?.file === artboard.file ? [] : pinnedOn(artboard.file)}
                    picking={picking && preview?.file !== artboard.file}
                    selecting={selecting && preview?.file !== artboard.file}
                    marks={marksFor(chips, artboard.file)}
                    tweaks={tweaks.values}
                    onPick={(pick) => {
                      if (selecting) return pickElement(pick, artboard.file);
                      setDraft({ ...pick, artboard: artboard.file });
                      setTab("comments");
                    }}
                    onEscape={() => setSelecting(false)}
                  />
                  )}
                  {tweaksOpenFor === artboard.file && (
                    <div
                      data-no-pan
                      role="dialog"
                      aria-label={`Tweaks de ${artboard.file}`}
                      className={styles.tweaksPopover}
                      style={{ left: frameWidth + 12, transform: `scale(${1 / view.zoom})` }}
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
                );
              })}
              </CanvasElements>
              )}
            </div>
          </div>
          {manifest?.artboards.length === 0 && manifest.elements.length === 0 && (
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
          {selecting && (
            <div data-testid="selection-hint" className={styles.selectionHint}>
              Sélection : clique sur un élément, un artboard ou une note pour l'ajouter au message <span className={styles.selectionHintKeys}>· Échap pour finir</span>
            </div>
          )}
          <div className={cx(styles.hintWrap, (selecting || missingArtboard !== null) && styles.hintWrapHidden)}>
            <div data-testid="mode-indicator" className={styles.hint}>
              {picking ? "Mode commentaire : clique sur un élément d'artboard ou du canvas. La bulle d'un bandeau commente l'artboard entier." : "Canvas interactif : les clics déclenchent les actions. Alt+clic pour commenter."}
            </div>
          </div>
          {missingArtboard !== null && (
            <div className={styles.missingWrap}>
              <div role="status" className={styles.missing}>
                Cet artboard n'existe plus · {missingArtboard}
                <button type="button" aria-label="Fermer" className={styles.missingClose} onClick={() => setMissingArtboard(null)}>
                  ×
                </button>
              </div>
            </div>
          )}
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
            <GuidesButton pressed={guidesVisible} onToggle={toggleGuides} className={cx(styles.guidesButton, guidesVisible && styles.guidesButtonOn)} />
            {responsiveArtboards.length > 0 && (
              <>
                <span aria-hidden="true" className={styles.zoomSeparator} />
                <RenderingsMenu
                  open={renderingsMenuOpen}
                  onOpenChange={setRenderingsMenuOpen}
                  formats={formatsOnPage}
                  hiddenFormats={viewSettings.hiddenFormats}
                  onToggle={(format, shown) => changeViewSettings(setFormatShown(viewSettings, format, shown))}
                />
              </>
            )}
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
            <button type="button" role="tab" aria-selected={tab === "toc"} className={cx(styles.tab, tab === "toc" && styles.tabActive)} onClick={() => setTab("toc")}>
              Sommaire
            </button>
          </div>
          {tab === "conversation" ? (
            <ConversationsPanel pageId={pageId} pageTitle={pageTitle} artboardCount={manifest?.artboards.length ?? 0} context={conversationContext} runs={runs} queue={queue} sessions={sessions} defaults={agentDefaults}
              chips={chips}
              selecting={selecting}
              onSelectingChange={changeSelecting}
              onRemoveChip={(index) => setChips((current) => removeChip(current, index))}
              onChipsSent={() => setChips([])}
            />
          ) : tab === "toc" ? (
            <div className={styles.tocPanel}>
              <TocList items={tocItems} currentFile={currentTocFile} placeholder={`Filtrer les ${tocItems.length} artboards…`} onSelect={centerOnArtboard} />
            </div>
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
