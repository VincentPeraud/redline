import { useAltKey } from "./useAltKey.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DRAFT_PREVIEW_QUERY,
  EMPTY_VIEW_SETTINGS,
  MANIFEST_PATH,
  MAX_FIT_HEIGHT,
  RESPONSIVE_FORMATS,
  componentNameOf,
  defaultManifest,
  groupTitlesOf,
  parseManifest,
  readingOrder,
  columnShifts,
  tweakGrid,
  tweakGridLayout,
  versionPreviewPath,
  type AgentInfo,
  type CreateThreadRequest,
  type Gap,
  canvasElementSummary,
  requestIsOpen,
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
  type TweakValues,
} from "@redline/shared";
import { useDesignSystemDetail } from "./DiffusionDialog.js";
import { ArtboardFrame, PinClickContext, type Pick } from "./ArtboardFrame.js";
import { ArtboardHistory } from "./ArtboardHistory.js";
import { restoreArtboard, useDeletedArtboards } from "./restoreArtboard.js";
import { SeenGapContext, type SeenGap } from "./GapsReport.js";
import { ArtboardErrorsContext, errorCountLabel, fixErrorsMessage, type ArtboardErrorsEntry } from "./ArtboardErrors.js";
import { fixGapsMessage, gapCountLabel } from "./gapLabels.js";
import { postInPageConversation } from "./askClaudeToFix.js";
import { useGaps } from "./useGaps.js";
import { UndoToast } from "./UndoToast.js";
import { CanvasHeader } from "./CanvasHeader.js";
import { PreviewBanner } from "./PreviewBanner.js";
import { ArchivedBanner, type ArchiveKind } from "./ArchiveControls.js";
import { useStoredToggle } from "./useStoredToggle.js";
import { GuidesButton } from "./GuidesButton.js";
import { isEditableTarget } from "./isEditableTarget.js";
import { centerOn, fitView, interpolateView, panBy, zoomWithin, type CanvasView } from "./canvasView.js";
import { boundsOf } from "./canvasPhotoFit.js";
import { photoArtboards } from "./CanvasPhoto.js";
import { OverviewMap } from "./OverviewMap.js";
import { copyAddress } from "./copyLink.js";
import { ArtboardMoreMenu } from "./ArtboardMoreMenu.js";
import { CopyLinkIcon } from "./CopyLinkIcon.js";
import { MissingArtboardNotice } from "./MissingArtboardNotice.js";
import { useCopiedBubble } from "./useCopiedBubble.js";
import { counted } from "./plural.js";
import { navigateTo, playRoute, type PageRoute } from "./router.js";
import { TocList } from "./TocList.js";
import { artboardAtCentre, type TocItem } from "./tocItems.js";
import { CanvasElements } from "./CanvasElements.js";
import { elementBox, responsiveFrameLayout, renderingSlots, type Box } from "./canvasGeometry.js";
import { ResponsiveFrame } from "./ResponsiveFrame.js";
import { TweakGridFrame } from "./TweakGridFrame.js";
import { RenderingChips, RenderingsMenu } from "./RenderingControls.js";
import { MissingInstanceElementsContext, ReplayRequestContext, ReportMissingInstanceElementsContext, ReportUnavailableStatesContext, UnavailableStatesContext, type ReplayRequest } from "./InstanceThreads.js";
import { PageTweaksContext } from "./RenderingChip.js";
import { hiddenRenderingKeys, hiddenThreadCounts, setFormatShown, toggleRendering } from "./viewSettings.js";
import { CommentsPanel, type Draft } from "./CommentsPanel.js";
import { ConversationsPanel, type FocusedConversation } from "./ConversationsPanel.js";
import type { AgentDefaults, ModelEffortChoice } from "./ModelEffortControls.js";
import { PlayMode } from "./PlayMode.js";
import { addChip, marksFor, removeChip } from "./elementChips.js";
import { messageContext } from "./messageContext.js";
import { TweaksPanel } from "./TweaksPanel.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { Tooltip, cx } from "./ui/index.js";
import { usePageSessions } from "./usePageSessions.js";
import { useRuns } from "./useRuns.js";
import { LEVEL_LABEL } from "./ProjectSharingDialog.js";
import { PHONE_VISITOR_MAX_WIDTH, useVisitor } from "./visitor.js";
import { VisitorComposer, VisitorThreadsPanel } from "./VisitorComments.js";
import { useTweaks } from "./useTweaks.js";
import { viaProjectField } from "./viaProject.js";
import styles from "./PageCanvas.module.css";

const ZOOM_STEP = 1.25;

/** Where the artboards start on screen at the initial view: left margin, and room above for the group title and artboard labels. */
const START_LEFT = 80;
const START_TOP = 190;
const START_BOTTOM = 40;
/** Pointer travel (screen pixels) under which a press and release count as a click. */
const CLICK_SLOP = 4;

type SideTab = "conversation" | "comments" | "toc";

/** Initial view: artboards at 100 % under the group titles, shrunk when they would not fit the stage height. */
function initialView(manifest: Manifest, stage: { width: number; height: number }): CanvasView {
  const bounds = boundsOf(manifest.artboards.map((a) => ({ x: a.x, y: a.y, width: a.width, height: a.height })));
  const zoom = Math.min(1, (stage.height - START_TOP - START_BOTTOM) / bounds.height);
  return { zoom, x: START_LEFT - bounds.x * zoom, y: START_TOP - bounds.y * zoom };
}

const OUTLINE_MS = 2000;
/** Length of the glide from one artboard to another when the table of contents picks it. */
const GLIDE_MS = 450;
/** How long a pin drawn again waits for the bridge to place it on its element. */
const PIN_SETTLE_MS = 150;

const ignoreErrors = () => undefined;

function BubbleIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}

/** A comment being written: pinned on an element of an artboard, or on a whole artboard. */
type PageDraft =
  | (Pick & { artboard: string; rendering?: ThreadRendering; cell?: TweakValues })
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
  /** Id of the page's project; for a design system's own page it is the design system's id (`project` is null then). */
  projectId: string;
  /** The page belongs to a design system's own project. */
  designSystemPage: boolean;
  /** Path -> content hash of the current version. */
  files: Record<string, string>;
  artboardOrigin: string;
  versionId: string;
  /** Called after the page got a new version from this canvas (a saved tweak). */
  onVersionChange: () => void;
  /** The page's view settings as the server has them. */
  viewSettings?: PageViewSettings;
  /** The page address: `artboard` (`.../artboards/<file>`) is centred and outlined once, `play` (`.../play/<file>`) is shown in play mode with the `?rendu=` value `renderingParam`. */
  route: PageRoute;
  /** The page's project or design system is archived: the canvas is read-only behind its banner. */
  archived?: { kind: ArchiveKind; archivedAt: string; onUnarchived: () => void };
}

export function PageCanvas({ pageId, pageTitle, project, projectId, designSystemPage, files, artboardOrigin, versionId, onVersionChange, viewSettings: savedViewSettings, route, archived }: Props) {
  const { artboard: addressedArtboard, play: playFile, renderingParam, previewOf } = route;
  /** Previewed with a design system's draft: read-only, nothing here comments, converses, saves or publishes. */
  const previewing = previewOf !== undefined;
  /** Previewed, or archived: nothing comments, saves or publishes (an archived page still shows its threads and conversations). */
  /** The viewer's level (a design system's page has no project: everyone works there). Lecture only reads, Commentaire also comments. */
  const visitor = useVisitor();
  const level = visitor?.view.level ?? project?.viewerLevel ?? "write";
  const canComment = level !== "read";
  const canWork = level === "write";
  const readOnly = previewing || archived !== undefined || !canComment;
  /** Archived, or below Écriture: no edit, tweak, restore, move, rename or message to Claude. */
  const frozen = archived !== undefined || !canWork;
  const archivedLabel = archived?.kind === "page" ? "Page archivée" : archived ? "Projet archivé" : `Niveau ${LEVEL_LABEL[level]}`;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [pickingRequested, setPicking] = useState(false);
  const picking = pickingRequested && !readOnly;
  const altPressed = useAltKey();
  const alt = altPressed && !readOnly;
  /** The conversation's selection mode ("+ Élément"), exclusive with comment mode. */
  const [selecting, setSelecting] = useState(false);
  // Archived while selecting elements for a message (or before the project was known): no message can be sent any more.
  useEffect(() => {
    if (readOnly) setSelecting(false);
  }, [readOnly]);
  /** Elements the user points at for the next conversation message, numbered by position. */
  const [chips, setChips] = useState<ThreadTarget[]>([]);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelEffortChoice>({});
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>({});
  const [tab, setTab] = useState<SideTab>("conversation");
  /** Artboard whose whole-artboard threads the Commentaires tab scrolls to once shown. */
  const [scrollToArtboard, setScrollToArtboard] = useState<string | null>(null);
  const [scrollToThread, setScrollToThread] = useState<string | null>(null);
  /** Resolved threads unfolded in the comments panel: only these show their (resolved) pin again. */
  const [unfoldedResolved, setUnfoldedResolved] = useState<ReadonlySet<string>>(new Set());
  /** A thread to glide to once its pin is drawn (a resolved thread just unfolded). */
  const [showAfterRender, setShowAfterRender] = useState<string | null>(null);
  const [tweaksOpenFor, setTweaksOpenFor] = useState<string | null>(null);
  const [moreOpenFor, setMoreOpenFor] = useState<string | null>(null);
  /** Bumped when the page's design system changed: artboards remount to load the new tokens. */
  const [tokensVersion, setTokensVersion] = useState(0);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [historyOpenFor, setHistoryOpenFor] = useState<string | null>(null);
  /** An old version shown in place of one artboard, read-only, until restored or cancelled. */
  const [preview, setPreview] = useState<{ file: string; versionId: string } | null>(null);
  /** The conversation the panel must show, set when something posts a message in it from outside the panel. */
  const [focusedConversation, setFocusedConversation] = useState<FocusedConversation | null>(null);
  const [toast, setToast] = useState<{ message: string; undo: () => Promise<void> } | null>(null);
  const deleted = useDeletedArtboards(pageId, versionId);
  /** The gap "Voir" points at: its artboard outlines the element. */
  const [seenGap, setSeenGap] = useState<SeenGap | null>(null);
  const seenFile = useRef<string | null>(null);
  const designSystemId = designSystemPage ? projectId : undefined;
  const designSystemDetail = useDesignSystemDetail(designSystemId, versionId);
  const pendingComponents = designSystemDetail?.pending.components;
  const componentChange = (file: string): "modifié" | "nouveau" | null => {
    const name = componentNameOf(file);
    if (name === null || !pendingComponents) return null;
    return pendingComponents.added.includes(name) ? "nouveau" : pendingComponents.changed.includes(name) ? "modifié" : null;
  };
  const [guidesVisible, toggleGuides] = useStoredToggle("redline:guides", false);
  const [overviewVisible, toggleOverview] = useStoredToggle("redline:overview", true);
  /** Box holding the artboards and every canvas element, as laid out on the canvas. */
  const [contentBounds, setContentBounds] = useState<Box | null>(null);
  /** Real page height of each rendering of a responsive artboard, by artboard file then rendering key, as reported by the bridge. */
  const [docHeights, setDocHeights] = useState<Record<string, Record<string, number>>>({});
  /** Real page height of each plain artboard, by file, as reported by the bridge. */
  const [pageHeights, setPageHeights] = useState<Record<string, number>>({});
  /** Errors reported by the iframes of each artboard, by file then iframe; what this viewer's browser saw, never stored. */
  const [frameErrors, setFrameErrors] = useState<Record<string, Record<string, string[]>>>({});
  /** One stable reporter per artboard file, so the context value does not change on every render. */
  const errorReporters = useRef(new Map<string, (frameId: string, errors: string[]) => void>());
  const reportErrors = (file: string) => {
    let reporter = errorReporters.current.get(file);
    if (!reporter) {
      reporter = (frameId, errors) =>
        setFrameErrors((current) => {
          const known = current[file]?.[frameId];
          if ((known ?? []).join("\n") === errors.join("\n") && (known !== undefined || errors.length === 0)) return current;
          const { [frameId]: _dropped, ...others } = current[file] ?? {};
          return { ...current, [file]: errors.length === 0 ? others : { ...others, [frameId]: errors } };
        });
      errorReporters.current.set(file, reporter);
    }
    return reporter;
  };
  /** Thread ids found gone from their component instance, by iframe, as the bridges reported them. */
  const [missingByFrame, setMissingByFrame] = useState<Record<string, string[]>>({});
  const reportMissing = useCallback(
    (frameId: string, threadIds: string[]) =>
      setMissingByFrame((current) => {
        if ((current[frameId] ?? []).join() === threadIds.join()) return current;
        const { [frameId]: _dropped, ...others } = current;
        return threadIds.length === 0 ? others : { ...others, [frameId]: threadIds };
      }),
    [],
  );
  const missingInstanceElements = useMemo(() => new Set(Object.values(missingByFrame).flat()), [missingByFrame]);
  /** Remembered instance states that can no longer be replayed (indexes by thread id), by iframe. */
  const [unavailableByFrame, setUnavailableByFrame] = useState<Record<string, Record<string, number[]>>>({});
  const reportUnavailable = useCallback(
    (frameId: string, unavailable: Record<string, number[]>) =>
      setUnavailableByFrame((current) => {
        if (JSON.stringify(current[frameId] ?? {}) === JSON.stringify(unavailable)) return current;
        const { [frameId]: _dropped, ...others } = current;
        return Object.keys(unavailable).length === 0 ? others : { ...others, [frameId]: unavailable };
      }),
    [],
  );
  const unavailableStates = useMemo(() => new Map(Object.values(unavailableByFrame).flatMap((byThread) => Object.entries(byThread))), [unavailableByFrame]);
  const [replay, setReplay] = useState<ReplayRequest | null>(null);
  /** The thread whose state was just replayed, whose pin `showThread` is waiting for. */
  const replayedFor = useRef<string | null>(null);
  /** Last growth of each fit artboard: a page that grows by the same step again is growing with its own viewport (min-height: 100vh plus a margin), and is left at its size. */
  const fitGrowth = useRef(new Map<string, number>());
  const [viewSettings, setViewSettings] = useState<PageViewSettings>(savedViewSettings ?? EMPTY_VIEW_SETTINGS);
  const allGaps = useGaps(pageId, `${versionId}:${tokensVersion}`);
  const gapReport = allGaps && { ...allGaps, gaps: allGaps.gaps.filter((gap) => !viewSettings.gapExceptions.includes(gap.key)) };
  const gapExceptionCount = allGaps ? allGaps.gaps.length - gapReport!.gaps.length : 0;
  const gapsOf = (file: string) => (gapReport?.gaps ?? []).filter((gap) => gap.file === file).length;
  /** Requests to the design system still open on a component's artboard (threads of this page, so the design system's own page). */
  const openRequestsOn = (file: string) => threads.filter((thread) => thread.request && requestIsOpen(thread.request) && thread.artboard === file).length;
  const [renderingsMenuOpen, setRenderingsMenuOpen] = useState(false);
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, zoom: 1 });
  /** Frame request of the running glide, stopped as soon as the user pans or zooms. */
  const glide = useRef<number | null>(null);
  /** The latest "Tout voir", for the keyboard shortcut. */
  const fitAllRef = useRef(() => {});
  /** The "Tout voir" view, the floor of the user's zoom (see `zoomWithin`). Read by the wheel listener. */
  const fitViewRef = useRef<CanvasView | null>(null);
  /** Whether the page has an overview to show or hide with M. */
  const hasOverviewRef = useRef(false);
  const stopGlide = useCallback(() => {
    if (glide.current !== null) cancelAnimationFrame(glide.current);
    glide.current = null;
  }, []);
  useEffect(() => stopGlide, [stopGlide]);
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const placed = useRef(false);
  /** Artboard outlined for a moment after an address centred on it. */
  const [outlined, setOutlined] = useState<string | null>(null);
  /** File of an address that names an artboard the manifest no longer has. */
  const [missingArtboard, setMissingArtboard] = useState<string | null>(null);
  /** Strip whose "Lien copié" bubble is up; `at` restarts the timer on a second copy. */
  const [copied, showCopied] = useCopiedBubble<string>();
  const artboardBoxesRef = useRef<Map<string, Box>>(new Map());
  const handledAddress = useRef<string | undefined>(undefined);
  const drag = useRef<{ x: number; y: number } | null>(null);
  /** Where the pointer went down, to tell a click on a canvas element from the end of a pan. */
  const pressedAt = useRef<{ x: number; y: number } | null>(null);

  const artboardTitles = useMemo(() => manifest?.artboards.map((a) => ({ file: a.file, title: a.title ?? a.file })) ?? null, [manifest]);
  const playing = playFile !== undefined && manifest !== null && manifest.artboards.some((a) => a.file === playFile);

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
      stopGlide();
      const rect = element!.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        setView((v) => zoomWithin(v, Math.exp(-event.deltaY * 0.01), cursor, fitViewRef.current));
      } else {
        setView((v) => panBy(v, -event.deltaX, -event.deltaY));
      }
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [playing, stopGlide]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [playing]);

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

  // A play address naming an artboard the manifest no longer has lands on the canvas with the same message, and an existing one clears it.
  useEffect(() => {
    if (playFile !== undefined && manifest) setMissingArtboard(playing ? null : playFile);
  }, [playFile, manifest, playing]);

  useEffect(() => {
    if (outlined === null) return;
    const timer = setTimeout(() => setOutlined(null), OUTLINE_MS);
    return () => clearTimeout(timer);
  }, [outlined]);

  function copyLink(route: PageRoute, file: string) {
    void copyAddress(route).then(() => showCopied(file));
  }

  function zoomFromCenter(factor: number) {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    stopGlide();
    setView((v) => zoomWithin(v, factor, { x: rect.width / 2, y: rect.height / 2 }, fitViewRef.current));
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

  /** A project link in Écriture reads the threads of every page of the project, newest first. */
  const projectWide = visitor?.view.level === "write" && visitor.view.scope === "project";
  const [projectThreads, setProjectThreads] = useState<Thread[]>([]);
  const [pageTitles, setPageTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!projectWide) return;
    const load = async () => {
      const [threadsRes, pagesRes] = await Promise.all([fetch(`/api/projects/${projectId}/threads`), fetch(`/api/projects/${projectId}/pages`)]);
      setProjectThreads((await threadsRes.json()) as Thread[]);
      setPageTitles(Object.fromEntries(((await pagesRes.json()) as { id: string; title: string }[]).map((page) => [page.id, page.title])));
    };
    void load();
    return subscribeServerEvents((event) => {
      if (event.type === "thread-updated") void load();
    });
  }, [projectWide, projectId]);

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

  // A pin was clicked: bring its thread into view and flash it so the eye finds it.
  useEffect(() => {
    if (scrollToThread === null || tab !== "comments") return;
    const card = document.querySelector<HTMLElement>(`[data-thread="${CSS.escape(scrollToThread)}"]`);
    setScrollToThread(null);
    if (!card) return;
    card.scrollIntoView({ block: "nearest" });
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      card.animate([{ boxShadow: "0 0 0 3px var(--color-accent)" }, { boxShadow: "0 0 0 3px transparent" }], { duration: 1200, easing: "ease-out" });
    }
  }, [scrollToThread, tab, threads]);

  function unfoldResolved(threadId: string, open: boolean) {
    setUnfoldedResolved((current) => {
      const next = new Set(current);
      if (open) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
    if (open) setShowAfterRender(threadId);
  }
  useEffect(() => {
    if (showAfterRender === null) return;
    // The pin is first drawn at its stored spot; the artboard's bridge moves it onto its element a moment later.
    const settle = setTimeout(() => {
      setShowAfterRender(null);
      showThread(showAfterRender);
    }, PIN_SETTLE_MS);
    return () => clearTimeout(settle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAfterRender]);

  const openPinThread = useCallback((threadId: string) => {
    setTab("comments");
    setScrollToThread(threadId);
  }, []);

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
      if (playing || isEditableTarget(event.target) || event.metaKey || event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "c" && !readOnly) {
        setPicking(true);
        setSelecting(false);
      }
      if (key === "p") setPicking(false);
      if (key === "g") toggleGuides();
      if (key === "f") fitAllRef.current();
      if (key === "m" && hasOverviewRef.current) toggleOverview();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGuides, toggleOverview, playing, readOnly]);

  /** "Envoyer" sends the comment now; "Plus tard" (`held`) keeps it on the server until "Tout envoyer". */
  async function send(held: boolean, visitorName?: string) {
    if (!draft || text.trim() === "") return;
    const request: CreateThreadRequest = visitor
      ? { ...threadPlace(draft), body: text, visitorName }
      : { ...threadPlace(draft), body: text, ...(held ? { held } : choice), ...viaProjectField(pageId) };
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
    if (readOnly || frozen) return;
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

  const pickElement = (pick: Pick, artboard: string, rendering?: ThreadRendering, cell?: TweakValues) =>
    setChips((current) => addChip(current, { kind: "element", artboard, selector: pick.selector, elementName: pick.elementName ?? null, xPct: pick.xPct, yPct: pick.yPct, ...(rendering && { rendering }), ...(cell && { cell }) }));

  async function renamePage(title: string) {
    const res = await fetch(`/api/pages/${pageId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error(`Rename refused (${res.status})`);
    onVersionChange();
  }

  const openCount = threads.filter((t) => t.status !== "resolved").length;
  const runningCount = runs.filter((r) => r.status === "running" || r.status === "sent" || r.status === "retrying").length;
  const firstArtboard = manifest?.artboards[0]?.file;
  // Stable per pick: the comments panel focuses its textarea when this changes.
  const draftInfo: Draft | null = useMemo(() => draft && { label: draftLabel(draft) }, [draft]);
  // A resolved thread no longer marks the canvas, unless it is unfolded in the comments panel.
  const pinnedThreads = threads.filter((t) => t.status !== "resolved" || unfoldedResolved.has(t.id));
  const pinnedOn = (file: string) => pinnedThreads.filter((t) => t.target.kind === "element" && t.artboard === file);
  const wholeArtboardThreads = (file: string) => threads.filter((t) => t.target.kind === "artboard" && t.artboard === file && t.status !== "resolved");
  const hiddenOf = (artboard: Manifest["artboards"][number]) => (artboard.responsive ? hiddenRenderingKeys(artboard.responsive, viewSettings, artboard.file) : new Set<string>());
  const layoutOf = (artboard: Manifest["artboards"][number]) =>
    artboard.responsive ? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive), { measuredHeights: docHeights[artboard.file], hidden: hiddenOf(artboard) }) : null;
  const gridOf = (artboard: Manifest["artboards"][number]) =>
    artboard.matrix ? tweakGridLayout(tweakGrid(artboard.matrix, manifest?.tweaks ?? []), artboard) : null;
  /** Height of a plain artboard on the canvas: its page's real height when it declares "fit", else the declared one. */
  const heightOf = (artboard: Manifest["artboards"][number]) => (artboard.fitHeight ? (pageHeights[artboard.file] ?? artboard.height) : artboard.height);
  /** Real height of a fixed plain artboard's page when it is taller than the artboard. */
  const tallerContent = (artboard: Manifest["artboards"][number]) => {
    const measured = pageHeights[artboard.file];
    return !artboard.fitHeight && !artboard.responsive && !artboard.matrix && measured !== undefined && measured > artboard.height + 1 ? measured : undefined;
  };
  const errorsByFile = new Map(Object.entries(frameErrors).map(([file, frames]) => [file, [...new Set(Object.values(frames).flat())]]));
  const errorsOf = (file: string) => errorsByFile.get(file) ?? [];
  const errorEntries: ArtboardErrorsEntry[] = (manifest?.artboards ?? []).flatMap((artboard) => {
    const errors = errorsOf(artboard.file);
    return errors.length > 0 ? [{ file: artboard.file, title: artboard.title ?? artboard.file, errors }] : [];
  });
  /** Records the page height a live plain artboard reported; a fit artboard caught growing with its own viewport keeps its size. */
  function measuredPageHeight(artboard: Manifest["artboards"][number], height: number) {
    if (artboard.fitHeight) {
      const growth = height - heightOf(artboard);
      if (growth > 0 && (fitGrowth.current.get(artboard.file) === growth || height > MAX_FIT_HEIGHT)) return;
      fitGrowth.current.set(artboard.file, growth);
    }
    setPageHeights((current) => (current[artboard.file] === height ? current : { ...current, [artboard.file]: height }));
  }
  const responsiveArtboards = (manifest?.artboards ?? []).filter((artboard) => artboard.responsive);
  const formatsOnPage = (Object.keys(RESPONSIVE_FORMATS) as ResponsiveFormat[])
    .map((format) => ({ format, frames: responsiveArtboards.filter((a) => a.responsive!.some((r) => r.format === format)).length }))
    .filter(({ frames }) => frames > 0);
  // Under an artboard that is taller or shorter than declared (renderings at their real height, a fit height), its column moves with it.
  // Only recomputed when a height or the shown renderings change, not on every pan or zoom.
  const { placedArtboards, placedElements } = useMemo(() => {
    const artboards = manifest?.artboards ?? [];
    const elements = manifest?.elements ?? [];
    const elementId = (index: number, end = "") => `\u0000element ${index}${end}`;
    const point = (id: string, at: { x: number; y: number }) => ({ id, box: { x: at.x, y: at.y, width: 0, height: 0 }, shownHeight: 0 });
    const shifts = columnShifts([
      ...artboards.map((artboard) => ({
        id: artboard.file,
        box: artboard.responsive ? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive)).frame : { x: artboard.x, y: artboard.y, ...(gridOf(artboard) ?? { width: artboard.width, height: artboard.height }) },
        shownHeight: layoutOf(artboard)?.frame.height ?? gridOf(artboard)?.height ?? heightOf(artboard),
      })),
      ...elements.flatMap((element, index) => {
        if (element.kind === "arrow") return [element.from, element.to].flatMap((end, i) => (typeof end === "string" ? [] : [point(elementId(index, i === 0 ? " from" : " to"), end)]));
        if ("anchor" in element && element.anchor) return [];
        const box = elementBox(element, undefined);
        return box ? [{ id: elementId(index), box, shownHeight: box.height }] : [];
      }),
    ]);
    const moved = <T extends { x: number; y: number }>(at: T, id: string): T => {
      const shift = shifts.get(id) ?? 0;
      return shift === 0 ? at : { ...at, y: at.y + shift };
    };
    return {
      placedArtboards: artboards.map((artboard) => moved(artboard, artboard.file)),
      placedElements: elements.map((element, index) => {
        if (element.kind === "arrow") {
          const end = (at: typeof element.from, name: string) => (typeof at === "string" ? at : moved(at, elementId(index, name)));
          const from = end(element.from, " from");
          const to = end(element.to, " to");
          return from === element.from && to === element.to ? element : { ...element, from, to };
        }
        return "anchor" in element && element.anchor ? element : moved(element, elementId(index));
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutOf, gridOf and heightOf read only these
  }, [manifest, docHeights, pageHeights, viewSettings]);
  const artboardBoxes = new Map<string, Box>(
    placedArtboards.map((artboard) => [artboard.file, layoutOf(artboard)?.frame ?? { x: artboard.x, y: artboard.y, ...(gridOf(artboard) ?? { width: artboard.width, height: heightOf(artboard) }) }]),
  );
  artboardBoxesRef.current = artboardBoxes;
  const tocItems: TocItem[] = readingOrder(
    placedArtboards.map((artboard) => ({ file: artboard.file, title: artboard.title, ...artboardBoxes.get(artboard.file)! })),
    manifest ? groupTitlesOf(manifest) : [],
  ).map((entry) => ({ ...entry, openThreads: threads.filter((t) => t.artboard === entry.file && t.status !== "resolved").length }));
  const hasContent = manifest !== null && (manifest.artboards.length > 0 || manifest.elements.length > 0);
  hasOverviewRef.current = hasContent;
  // Only rebuilt when the layout or a page changes, so panning and zooming do not redraw the mini-map.
  const overviewArtboards = useMemo(
    () =>
      hasContent
        ? photoArtboards(placedArtboards, manifest.tweaks, (file) => ({ src: artboardSrc(file), version: `${files[file]}@${tokensVersion}@${preview?.file === file ? preview.versionId : ""}` }), { heightOf, responsiveOf: layoutOf })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- artboardSrc, heightOf and layoutOf read only these
    [hasContent, placedArtboards, manifest, files, tokensVersion, preview, previewing, artboardOrigin, pageId, docHeights, pageHeights, viewSettings],
  );
  // A phone opens a share link in the presentation, one artboard at a time.
  const firstToPlay = tocItems[0]?.file;
  useEffect(() => {
    if (visitor && playFile === undefined && firstToPlay !== undefined && window.innerWidth <= PHONE_VISITOR_MAX_WIDTH) navigateTo(playRoute(pageId, firstToPlay), "replace");
  }, [visitor, playFile, firstToPlay, pageId]);
  if (playing && manifest && playFile !== undefined) {
    return (
      <PlayMode
        pageId={pageId}
        pageTitle={pageTitle}
        manifest={manifest}
        tocItems={tocItems}
        file={playFile}
        renderingParam={renderingParam}
        artboardOrigin={artboardOrigin}
        tweaks={tweaks.values}
        onTweak={tweaks.setValue}
        guidesVisible={guidesVisible}
        onToggleGuides={toggleGuides}
        onExit={() => navigateTo({ name: "page", pageId })}
      />
    );
  }

  const currentTocFile = artboardAtCentre(
    [...artboardBoxes].map(([file, box]) => ({ file, ...box })),
    view,
    viewportSize,
  );
  function seeGap(gap: Gap) {
    const artboard = manifest?.artboards.find((a) => a.file === gap.file);
    if (!artboard || gap.selector === null) return;
    setSeenGap({ src: `${artboardOrigin}/pages/${pageId}/${gap.file}`, selector: gap.selector, nonce: Date.now() });
    // A plain artboard is centred on the element once the bridge reports its box; a frame of renderings or cells on the artboard.
    seenFile.current = layoutOf(artboard) || gridOf(artboard) ? null : gap.file;
    if (seenFile.current === null) centerOnArtboard(gap.file);
  }
  async function askClaudeToFixGaps() {
    if (!gapReport) return;
    setTab("conversation");
    const conversationId = await postInPageConversation(pageId, fixGapsMessage(gapReport.designSystemTitle, gapReport.gaps));
    setFocusedConversation({ id: conversationId, nonce: Date.now() });
  }

  async function askClaudeToFixErrors() {
    setTab("conversation");
    const conversationId = await postInPageConversation(pageId, fixErrorsMessage(errorEntries));
    setFocusedConversation({ id: conversationId, nonce: Date.now() });
  }

  function centerOnSeenGap(rect: { x: number; y: number; width: number; height: number }) {
    const box = seenFile.current === null ? undefined : artboardBoxesRef.current.get(seenFile.current);
    seenFile.current = null;
    if (box) setView(centerOn({ x: box.x + rect.x, y: box.y + rect.y, width: rect.width, height: rect.height }, viewportSize));
  }
  /** Glides to a thread's pin, zoomed in at least enough to see its whole artboard, then makes the pin pulse; no pin (a resolved or whole-artboard thread): to the artboard. */
  function showThread(threadId: string) {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    const pin = document.querySelector<HTMLElement>(`[data-pin-thread="${CSS.escape(threadId)}"]`);
    const stage = viewport.current?.getBoundingClientRect();
    // The pin waits hidden for the instances to take the state the thread was written in; show it once they have.
    if (!pin && thread.instanceState && replayedFor.current !== threadId) {
      replayedFor.current = threadId;
      setReplay({ threadId, nonce: Date.now() });
      setShowAfterRender(threadId);
      return;
    }
    replayedFor.current = null;
    if (!pin || !stage) {
      if (thread.artboard) centerOnArtboard(thread.artboard);
      return;
    }
    const spot = pin.getBoundingClientRect();
    const x = (spot.left + spot.width / 2 - stage.left - view.x) / view.zoom;
    const y = (spot.top + spot.height / 2 - stage.top - view.y) / view.zoom;
    const box = thread.artboard ? artboardBoxes.get(thread.artboard) : undefined;
    const zoom = Math.max(view.zoom, box ? centerOn(box, viewportSize).zoom : view.zoom);
    glideTo({ zoom, x: viewportSize.width / 2 - x * zoom, y: viewportSize.height / 2 - y * zoom });
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const ring = "0 0 0 3px var(--color-surface)";
      pin.animate([{ boxShadow: `${ring}, 0 0 0 4px var(--color-accent)` }, { boxShadow: `${ring}, 0 0 0 14px transparent` }], { duration: 700, delay: GLIDE_MS, iterations: 2, easing: "ease-out" });
    }
  }
  function centerOnArtboard(file: string) {
    const box = artboardBoxes.get(file);
    if (!box) return;
    glideTo(centerOn(box, viewportSize));
  }
  function glideTo(target: CanvasView) {
    stopGlide();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setView(target);
      return;
    }
    const from = view;
    const size = viewportSize;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setView(interpolateView(from, target, eased, size));
      glide.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    glide.current = requestAnimationFrame(step);
  }
  /** The page an artboard shows: an old version being previewed, the draft in a design system preview, else the live one. */
  function artboardSrc(file: string) {
    return preview?.file === file
      ? `${artboardOrigin}${versionPreviewPath(pageId, preview.versionId, file)}`
      : `${artboardOrigin}/pages/${pageId}/${file}${previewing ? `?${DRAFT_PREVIEW_QUERY}` : ""}`;
  }
  /** "Tout voir (F)": glides to the view that shows the whole canvas. */
  function fitAll() {
    if (contentBounds && viewportSize.width > 0) glideTo(fitView(contentBounds, viewportSize));
  }
  fitAllRef.current = fitAll;
  fitViewRef.current = contentBounds && viewportSize.width > 0 ? fitView(contentBounds, viewportSize) : null;
  const conversationContext = messageContext({ view, viewport: viewportSize, boxes: artboardBoxes, manifest, tweakValues: tweaks.values });
  const artboardTweaks = (file: string) => (manifest?.tweaks ?? []).filter((tweak) => (tweak.artboard ? tweak.artboard === file : file === firstArtboard));

  const canvasMarks = chips.flatMap((chip, index) => (chip.kind === "canvas-element" ? [{ number: index + 1, elementId: chip.elementId }] : []));

  return (
    <SeenGapContext.Provider value={{ seen: seenGap, onRect: centerOnSeenGap }}>
    <ReportMissingInstanceElementsContext.Provider value={reportMissing}>
    <MissingInstanceElementsContext.Provider value={missingInstanceElements}>
    <ReportUnavailableStatesContext.Provider value={reportUnavailable}>
    <UnavailableStatesContext.Provider value={unavailableStates}>
    <ReplayRequestContext.Provider value={replay}>
    <PinClickContext.Provider value={previewing ? undefined : openPinThread}>
    <div className={styles.page}>
      {previewOf !== undefined && <PreviewBanner designSystemId={previewOf} onLeave={() => navigateTo({ name: "page", pageId })} />}
      <CanvasHeader
        previewOf={previewOf}
        project={project}
        designSystemId={designSystemId}
        designSystemTitle={designSystemDetail?.title}
        versionId={versionId}
        pageId={pageId}
        pageTitle={pageTitle}
        picking={picking}
        onPickingChange={(next) => {
          setPicking(next);
          if (next) setSelecting(false);
        }}
        runningCount={runningCount}
        artboardOrigin={artboardOrigin}
        deleted={readOnly || frozen ? [] : deleted}
        onPutBack={(item) => restore(item.file, item.lastVersionId)}
        onRenamePage={renamePage}
        toc={{ items: tocItems, currentFile: currentTocFile, onSelect: centerOnArtboard }}
        gaps={gapReport}
        gapExceptionCount={gapExceptionCount}
        onSeeGap={seeGap}
        onGapException={(gap) => changeViewSettings({ ...viewSettings, gapExceptions: [...viewSettings.gapExceptions, gap.key] })}
        onShowGapExceptions={() => changeViewSettings({ ...viewSettings, gapExceptions: [] })}
        onAskFixGaps={() => void askClaudeToFixGaps()}
        errors={errorEntries}
        onSeeErrors={centerOnArtboard}
        onAskFixErrors={() => void askClaudeToFixErrors()}
        archived={frozen}
        commentOnly={archived === undefined && !canWork && canComment}
      />
      {archived && (
        <ArchivedBanner
          kind={archived.kind}
          id={archived.kind === "page" ? pageId : projectId}
          archivedAt={archived.archivedAt}
          onUnarchived={archived.onUnarchived}
          deletion={
            archived.kind === "page"
              ? {
                  title: pageTitle,
                  contents: async () => {
                    const versions = ((await (await fetch(`/api/pages/${pageId}/versions`)).json()) as unknown[]).length;
                    const artboards = counted(manifest?.artboards.length ?? 0, "artboard", "artboards");
                    return `Ses ${artboards}, ${counted(threads.length, "fil", "fils")}, ${counted(versions, "version", "versions")} et ses conversations seront effacés. Les assets du projet restent.`;
                  },
                  onDeleted: () => navigateTo({ name: "project", projectId }, "replace"),
                }
              : undefined
          }
          className={styles.archivedBanner}
        />
      )}
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
              if (seenGap) setSeenGap(null);
              pressedAt.current = { x: e.clientX, y: e.clientY };
              stopGlide();
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
              if ((picking || selecting || (e.altKey && !readOnly)) && manifest && pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < CLICK_SLOP) {
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
              <CanvasElements elements={placedElements} artboardBoxes={artboardBoxes} assetBase={`${artboardOrigin}/pages/${pageId}`} artboardOrigin={artboardOrigin} picking={picking || selecting || alt} zoom={view.zoom} threads={pinnedThreads} marks={canvasMarks} onContentBounds={setContentBounds}>
              {placedArtboards.map((artboard) => {
                const layout = layoutOf(artboard);
                const grid = gridOf(artboard);
                const hidden = hiddenOf(artboard);
                const taller = tallerContent(artboard);
                const errorCount = errorsOf(artboard.file).length;
                const previewed = preview?.file === artboard.file;
                const frameWidth = artboardBoxes.get(artboard.file)!.width;
                const src = artboardSrc(artboard.file);
                return (
                <div
                  key={`${artboard.file}@${files[artboard.file]}@${tokensVersion}`}
                  data-artboard={artboard.file}
                  className={cx(styles.artboard, (historyOpenFor === artboard.file || tweaksOpenFor === artboard.file || moreOpenFor === artboard.file) && styles.artboardRaised)}
                  style={{ left: artboard.x, top: artboard.y }}
                >
                  <div
                    data-no-pan
                    data-strip={artboard.file}
                    className={cx(styles.label, (layout || grid) && styles.labelResponsive, selecting && styles.labelSelecting)}
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
                    {copied === artboard.file && (
                      <div role="status" className={styles.copiedBubble}>
                        Lien copié
                      </div>
                    )}
                    <span
                      data-testid={componentNameOf(artboard.file) !== null ? "component-name" : undefined}
                      className={cx(styles.labelName, componentNameOf(artboard.file) !== null && styles.componentName, outlined === artboard.file && styles.labelNameOutlined)}
                    >
                      {componentNameOf(artboard.file) !== null ? `${artboard.title ?? componentNameOf(artboard.file)} · ${artboard.file}` : (artboard.title ?? artboard.file)}
                    </span>
                    {componentChange(artboard.file) && (
                      <span data-testid="component-change" className={cx(styles.changePill, componentChange(artboard.file) === "nouveau" ? styles.newPill : styles.modifiedPill)}>
                        {componentChange(artboard.file)}
                      </span>
                    )}
                    {openRequestsOn(artboard.file) > 0 && (
                      <span data-testid="artboard-requests" className={cx(styles.changePill, styles.requestsPill)}>
                        {counted(openRequestsOn(artboard.file), "demande", "demandes")}
                      </span>
                    )}
                    {gapsOf(artboard.file) > 0 && (
                      <span data-testid="artboard-gaps" className={cx(styles.changePill, styles.modifiedPill)}>
                        {gapCountLabel(gapsOf(artboard.file))}
                      </span>
                    )}
                    {errorCount > 0 && (
                      <span data-testid="artboard-errors" className={cx(styles.changePill, styles.errorPill)}>
                        {errorCountLabel(errorCount)}
                      </span>
                    )}
                    {taller !== undefined && (
                      <span data-testid="artboard-taller" className={cx(styles.changePill, styles.tallerPill)}>
                        ↕ {Math.ceil(taller).toLocaleString("fr-FR")} px
                      </span>
                    )}
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
                    {grid && artboard.matrix && (
                      <span className={styles.gridBadge}>
                        grille · {[artboard.matrix.rows, artboard.matrix.columns, artboard.matrix.blocks].flatMap((id) => (manifest?.tweaks.find((t) => t.id === id)?.label.toLowerCase() ?? [])).join(" × ")}
                      </span>
                    )}
                    {!previewing && wholeArtboardThreads(artboard.file).length > 0 && (
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
                    {!readOnly && !frozen && artboardTweaks(artboard.file).length > 0 && (
                      <button
                        type="button"
                        aria-label={`Tweaks · ${artboardTweaks(artboard.file).length}`}
                        aria-expanded={tweaksOpenFor === artboard.file}
                        className={styles.tweaksButton}
                        onClick={() => setTweaksOpenFor(tweaksOpenFor === artboard.file ? null : artboard.file)}
                      >
                        Tweaks
                        <span className={styles.tweaksCount}>{artboardTweaks(artboard.file).length}</span>
                      </button>
                    )}
                    {!previewing && (
                    <>
                    {!readOnly && (
                    <Tooltip label="Commenter l'artboard entier">
                      <button
                        type="button"
                        aria-label={`Commenter tout ${artboard.file}`}
                        className={styles.iconButton}
                        onClick={() => {
                          setDraft({ target: { kind: "artboard", artboard: artboard.file } });
                          setTab("comments");
                        }}
                      >
                        <BubbleIcon size={13} />
                      </button>
                    </Tooltip>
                    )}
                    {(!visitor || canWork) && (
                    <ArtboardHistory
                      pageId={pageId}
                      file={artboard.file}
                      pageVersionId={versionId}
                      open={historyOpenFor === artboard.file}
                      onOpenChange={(open) => setHistoryOpenFor(open ? artboard.file : null)}
                      previewVersionId={preview?.file === artboard.file ? preview.versionId : null}
                      onPreview={(previewId) => setPreview(previewId ? { file: artboard.file, versionId: previewId } : null)}
                      onRestore={(restoreId) => restore(artboard.file, restoreId)}
                      readOnly={frozen}
                    />
                    )}
                    <Tooltip label={`Copier le lien de ${artboard.file}`}>
                      <button
                        type="button"
                        aria-label={`Copier le lien de ${artboard.file}`}
                        className={styles.iconButton}
                        onClick={() => copyLink({ name: "page", pageId, artboard: artboard.file }, artboard.file)}
                      >
                        <CopyLinkIcon />
                      </button>
                    </Tooltip>
                    <Tooltip label="Plein écran">
                      <button
                        type="button"
                        aria-label={`Lancer ${artboard.file} en plein écran`}
                        className={styles.iconButton}
                        onClick={() => navigateTo(playRoute(pageId, artboard.file))}
                      >
                        <FullscreenIcon />
                      </button>
                    </Tooltip>
                    {!frozen && !visitor && (
                    <ArtboardMoreMenu
                      pageId={pageId}
                      file={artboard.file}
                      open={moreOpenFor === artboard.file}
                      onOpenChange={(open) => setMoreOpenFor(open ? artboard.file : null)}
                      onCopyPlayLink={() => copyLink(playRoute(pageId, artboard.file), artboard.file)}
                      contentHeight={taller}
                      onFitted={onVersionChange}
                    />
                    )}
                    </>
                    )}
                  </div>
                  {outlined === artboard.file && (
                    <span
                      data-artboard-outline
                      className={styles.artboardOutline}
                      style={{ width: frameWidth * view.zoom, height: artboardBoxes.get(artboard.file)!.height * view.zoom, transform: `scale(${1 / view.zoom})` }}
                    />
                  )}
                  {/* An old version shown in place of the artboard reports neither its errors nor its height: they are not the current ones. */}
                  <ArtboardErrorsContext.Provider value={previewed ? ignoreErrors : reportErrors(artboard.file)}>
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
                  ) : grid ? (
                    <TweakGridFrame
                      key={preview?.file === artboard.file ? preview.versionId : "live"}
                      title={`${pageTitle} / ${artboard.file}`}
                      src={src}
                      layout={grid}
                      zoom={view.zoom}
                      guides={guidesVisible ? artboard.guides : undefined}
                      threads={preview?.file === artboard.file ? [] : pinnedOn(artboard.file)}
                      picking={picking && preview?.file !== artboard.file}
                      selecting={selecting && preview?.file !== artboard.file}
                      marksOf={(cell) => marksFor(chips, artboard.file, undefined, cell)}
                      tweaks={tweaks.values}
                      onPick={(pick, cell) => {
                        if (selecting) return pickElement(pick, artboard.file, undefined, cell);
                        setDraft({ ...pick, artboard: artboard.file, cell });
                        setTab("comments");
                      }}
                      onEscape={() => setSelecting(false)}
                    />
                  ) : (
                  <ArtboardFrame
                    key={preview?.file === artboard.file ? preview.versionId : "live"}
                    title={`${pageTitle} / ${artboard.file}`}
                    src={src}
                    width={artboard.width}
                    height={heightOf(artboard)}
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
                    onDocHeight={(height) => !previewed && measuredPageHeight(artboard, height)}
                  />
                  )}
                  </ArtboardErrorsContext.Provider>
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
                        <Tooltip label="Fermer les tweaks">
                          <button type="button" aria-label="Fermer les tweaks" className={styles.popoverClose} onClick={() => setTweaksOpenFor(null)}>
                            ×
                          </button>
                        </Tooltip>
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
          {missingArtboard !== null && (
            <div className={styles.missingWrap}>
              <MissingArtboardNotice file={missingArtboard} onClose={() => setMissingArtboard(null)} className={styles.missing} />
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
          <div className={styles.bottomBar}>
          <div className={styles.zoom}>
            <Tooltip label="Dézoomer">
              <button type="button" aria-label="Dézoomer" className={styles.zoomButton} onClick={() => zoomFromCenter(1 / ZOOM_STEP)}>
                −
              </button>
            </Tooltip>
            <span className={styles.zoomValue}>{Math.round(view.zoom * 100)} %</span>
            <Tooltip label="Zoomer">
              <button type="button" aria-label="Zoomer" className={styles.zoomButton} onClick={() => zoomFromCenter(ZOOM_STEP)}>
                +
              </button>
            </Tooltip>
            <span aria-hidden="true" className={styles.zoomSeparator} />
            <button type="button" title="Voir tout le canvas (F)" className={styles.guidesButton} onClick={fitAll}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 9V4h5" />
                <path d="M15 4h5v5" />
                <path d="M20 15v5h-5" />
                <path d="M9 20H4v-5" />
              </svg>
              Tout voir (F)
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
          <div className={cx(styles.hintWrap, (previewing || visitor !== null || selecting || missingArtboard !== null) && styles.hintWrapHidden)}>
            <div data-testid="mode-indicator" className={styles.hint}>
              {picking
                ? "Mode commentaire : clique sur un élément d'artboard ou du canvas. La bulle d'un bandeau commente l'artboard entier."
                : archived
                  ? "Canvas interactif : les clics déclenchent les actions."
                  : "Canvas interactif : les clics déclenchent les actions. Alt+clic pour commenter."}
            </div>
          </div>
          {overviewArtboards && manifest && (
            <OverviewMap
              pageId={pageId}
              artboardOrigin={artboardOrigin}
              artboards={overviewArtboards}
              elements={placedElements}
              view={view}
              viewport={viewportSize}
              visible={overviewVisible}
              onToggle={toggleOverview}
              onMove={(next) => {
                stopGlide();
                setView(next);
              }}
            />
          )}
          </div>
        </main>

        {visitor && canComment && (
          <>
            <VisitorThreadsPanel
              threads={projectWide ? projectThreads : visitor.view.level === "write" ? [...threads].reverse() : threads}
              visitor={visitor}
              artboardTitles={Object.fromEntries((artboardTitles ?? []).map((a) => [a.file, a.title]))}
              otherPages={projectWide ? { currentPageId: pageId, titles: pageTitles } : undefined}
              claudeAvailable={project?.claudeAvailable}
              onShow={(threadId) => {
                const elsewhere = projectThreads.find((thread) => thread.id === threadId && thread.pageId !== pageId);
                if (elsewhere) navigateTo({ name: "page", pageId: elsewhere.pageId });
                else showThread(threadId);
              }}
            />
            {draft && (
              <div className={styles.visitorComposer}>
                <VisitorComposer
                  visitor={visitor}
                  label={draftLabel(draft)}
                  text={text}
                  onText={setText}
                  onSend={(visitorName) => send(false, visitorName)}
                  onCancel={() => {
                    setDraft(null);
                    setText("");
                  }}
                />
              </div>
            )}
          </>
        )}
        {!previewing && !visitor && (
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
            <ConversationsPanel pageId={pageId} pageTitle={pageTitle} versionId={versionId} artboardCount={manifest?.artboards.length ?? 0} artboards={artboardTitles} onCenterArtboard={centerOnArtboard} onMissingArtboard={setMissingArtboard} focusedConversation={focusedConversation} context={conversationContext} runs={runs} queue={queue} sessions={sessions} defaults={agentDefaults}
              chips={chips}
              selecting={selecting}
              onSelectingChange={changeSelecting}
              onRemoveChip={(index) => setChips((current) => removeChip(current, index))}
              onChipsSent={() => setChips([])}
              readOnly={frozen}
              archivedLabel={archivedLabel}
            />
          ) : tab === "toc" ? (
            <div className={styles.tocPanel}>
              <TocList items={tocItems} currentFile={currentTocFile} placeholder={`Filtrer les ${tocItems.length} artboards…`} onSelect={centerOnArtboard} />
            </div>
          ) : (
            <PageTweaksContext.Provider value={manifest?.tweaks ?? []}>
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
                readOnly={readOnly}
                commentOnly={archived === undefined && !canWork}
                archivedLabel={archivedLabel}
                unfolded={unfoldedResolved}
                onUnfold={unfoldResolved}
                onShowThread={showThread}
              />
            </PageTweaksContext.Provider>
          )}
        </aside>
        )}
      </div>
    </div>
    </PinClickContext.Provider>
    </ReplayRequestContext.Provider>
    </UnavailableStatesContext.Provider>
    </ReportUnavailableStatesContext.Provider>
    </MissingInstanceElementsContext.Provider>
    </ReportMissingInstanceElementsContext.Provider>
    </SeenGapContext.Provider>
  );
}
