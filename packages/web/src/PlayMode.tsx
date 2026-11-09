import { ArtboardIframe } from "./artboardCapability.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RESPONSIVE_FORMATS, renderingKey, renderingLabel, type ArtboardRendering, type CreateThreadRequest, type Manifest, type Project, type Thread, type TweakValue, type TweakValues } from "@redline/shared";
import { PlayStepper } from "./PlayStepper.js";
import type { TocItem } from "./tocItems.js";
import { TweaksPanel } from "./TweaksPanel.js";
import { PlayFrame } from "./PlayFrame.js";
import { presentationOf, type Presentation } from "./playFrames.js";
import { ArtboardGuides } from "./ArtboardGuides.js";
import { GuidesButton } from "./GuidesButton.js";
import { isEditableTarget } from "./isEditableTarget.js";
import { useStoredToggle } from "./useStoredToggle.js";
import { renderingParamOf, usePlayRendering } from "./usePlayRendering.js";
import { navigateTo, playRoute } from "./router.js";
import { loadPageSummary } from "./otherPageArtboards.js";
import { copyAddress } from "./copyLink.js";
import { CopyLinkIcon } from "./CopyLinkIcon.js";
import { MissingArtboardNotice } from "./MissingArtboardNotice.js";
import { useCopiedBubble } from "./useCopiedBubble.js";
import { StatusBadge, Tooltip, cx } from "./ui/index.js";
import { PHONE_VISITOR_MAX_WIDTH, useVisitor } from "./visitor.js";
import { VisitorComposer, VisitorThreadCards } from "./VisitorComments.js";
import { linkBadgeLabel } from "./VisitorHeader.js";
import { subscribeServerEvents } from "./serverEvents.js";
import type { Pick } from "./ArtboardFrame.js";
import styles from "./PlayMode.module.css";

/** Where a link leads: an artboard of this page (`page` null) or of another page (checked against that page when followed). */
export type LinkTarget = { page: string | null; file: string };

/** Target of the link on `selector` in artboard `from`, if the manifest declares one; a same-page target must exist. */
export function resolveLink(manifest: Manifest, pageId: string, from: string, selector: string): LinkTarget | null {
  const link = manifest.links.find((l) => l.from === from && l.selector === selector);
  if (!link) return null;
  if (link.page !== undefined && link.page !== pageId) return { page: link.page, file: link.to };
  return manifest.artboards.some((a) => a.file === link.to) ? { page: null, file: link.to } : null;
}

/** Value of the "Aucun" option of the phone bar's rendering select. */
const NO_RENDERING_OPTION = "none";

interface Props {
  pageId: string;
  pageTitle: string;
  manifest: Manifest;
  /** The artboards in reading order: the counter, the arrows and the contents menu follow it. */
  tocItems: TocItem[];
  /** Artboard shown: the file of the play address. */
  file: string;
  /** The play address's `?rendu=` value, as written. */
  renderingParam?: string;
  artboardOrigin: string;
  tweaks: TweakValues;
  onTweak: (id: string, value: TweakValue) => void;
  /** The per-viewer guides choice, shared with the canvas. */
  guidesVisible: boolean;
  onToggleGuides: () => void;
  onExit: () => void;
}

/** Viewport and scale that fit the presentation on the stage; a `fill` presentation stretches to the stage instead. */
function fitToStage(presentation: Presentation, stage: { width: number; height: number }) {
  const { viewport, fill, stagePadding, frameHeight } = presentation;
  if (fill === "both") return { viewport: stage, scale: 1 };
  if (stage.width === 0) return { viewport, scale: 1 };
  if (fill === "height") {
    const scale = Math.min(1, Math.max(0.1, stage.width / viewport.width));
    return { viewport: { width: viewport.width, height: stage.height / scale }, scale };
  }
  const scale = Math.min(
    1,
    Math.max(0.1, (stage.width - stagePadding * 2) / viewport.width),
    Math.max(0.1, (stage.height - stagePadding * 2 - frameHeight) / viewport.height),
  );
  return { viewport, scale };
}

/** One artboard at a time at full size; clicks on elements linked in the manifest switch artboard (via the bridge). */
export function PlayMode({ pageId, pageTitle, manifest, tocItems, file: current, renderingParam, artboardOrigin, tweaks, onTweak, guidesVisible, onToggleGuides, onExit }: Props) {
  const [copied, showCopied] = useCopiedBubble();
  const [menuOpen, setMenuOpen] = useState(false);
  const [deadLink, setDeadLink] = useState<string | null>(null);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  /** Background at the top of the shown page: the phone's status bar takes it, as Safari does. */
  const [topColour, setTopColour] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const artboard = manifest.artboards.find((a) => a.file === current);
  const [framed, toggleFramed] = useStoredToggle("redline:play-framed", true);
  const [tweaksOpen, toggleTweaks] = useStoredToggle("redline:play-tweaks", true);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const visitor = useVisitor();
  /** A share link on a phone: its own top and bottom bars, with only what the link's level allows. */
  const phoneVisitor = visitor !== null && windowWidth <= PHONE_VISITOR_MAX_WIDTH;
  /** A Commentaire link on a phone: "Commenter" picks an element of the shown artboard, "Commentaires" lists the link's threads. */
  const canComment = phoneVisitor && visitor.view.level !== "read";
  const [commenting, setCommenting] = useState(false);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [commentText, setCommentText] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [linkThreads, setLinkThreads] = useState<Thread[]>([]);
  /** An Écriture link reads like a member ("Commentaires", newest first) and is told when no agent serves the project. */
  const writing = visitor?.view.level === "write";
  const [claudeAvailable, setClaudeAvailable] = useState<boolean | undefined>(undefined);
  const renderings = artboard?.responsive ?? [];
  const [rendering, selectRendering] = usePlayRendering(renderings, renderingParam);
  const presentation = artboard && presentationOf(artboard, framed, windowWidth, artboard.responsive ? rendering : undefined);
  const isBrowserFrame = rendering ? rendering.format === "desktop" : artboard?.frame === "browser";
  const fitted = presentation && fitToStage(presentation, stageSize);
  /** A link the user followed pushes an entry; the header buttons replace the current one. */
  const showArtboard = (file: string, mode: "push" | "replace") => navigateTo(playRoute(pageId, file, renderingParam), mode);
  const position = tocItems.findIndex((item) => item.file === current);
  const goBy = (step: -1 | 1) => {
    const target = tocItems[position + step];
    if (target) showArtboard(target.file, "replace");
  };
  /** The target page's manifest and tweaks load with its own play route; a gone page or artboard leaves the screen as it is. */
  const followOtherPage = (otherPageId: string, file: string) =>
    void loadPageSummary(otherPageId)
      .catch(() => null)
      .then((summary) => {
        if (summary?.artboardTitles.has(file)) navigateTo(playRoute(otherPageId, file), "push");
        else setDeadLink(file);
      });
  const chooseRendering = (choice: ArtboardRendering | null) => {
    selectRendering(choice);
    navigateTo(playRoute(pageId, current, renderingParamOf(choice)), "replace");
  };
  const copyPlayUrl = () => void copyAddress(playRoute(pageId, current, renderings.length > 0 ? renderingParamOf(rendering) : undefined)).then(() => showCopied());
  /** "Desktop", or "Desktop · 1440" when the artboard has several renderings of the same format. */
  const renderingOptionLabel = (r: ArtboardRendering) => (renderings.filter((o) => o.format === r.format).length > 1 ? renderingLabel(r) : RESPONSIVE_FORMATS[r.format].label);

  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => setDeadLink(null), [pageId, current]);
  useEffect(() => {
    setCommenting(false);
    setPicked(null);
    setCommentText("");
  }, [pageId, current]);
  useEffect(() => {
    if (!canComment) return;
    const load = () =>
      void fetch(`/api/pages/${pageId}/threads`)
        .then((response) => response.json() as Promise<Thread[]>)
        .then(setLinkThreads);
    load();
    return subscribeServerEvents((event) => {
      if (event.type === "thread-updated" && event.pageId === pageId) load();
    });
  }, [canComment, pageId]);
  useEffect(() => {
    if (!canComment || !writing) return;
    void fetch(`/api/projects/${visitor.view.project.id}`)
      .then((response) => response.json() as Promise<Project>)
      .then((project) => setClaudeAvailable(project.claudeAvailable));
  }, [canComment, writing, visitor]);
  // Commenting turns the frame's clicks into picks instead of the manifest's links.
  useEffect(() => {
    if (bridgeEpoch === 0 || !canComment) return;
    const selectors = manifest.links.filter((l) => l.from === current).map((l) => l.selector);
    frame.current?.contentWindow?.postMessage({ type: "redline:set-links", selectors: commenting ? null : selectors }, "*");
    frame.current?.contentWindow?.postMessage({ type: "redline:set-mode", picking: commenting, selecting: false, alt: false }, "*");
  }, [commenting, bridgeEpoch, canComment, manifest, current]);
  useEffect(() => setTopColour(null), [pageId, current]);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-tweaks", values: tweaks }, "*");
  }, [tweaks, bridgeEpoch]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; selector?: string; key?: string; colour?: string } & Partial<Pick>;
      if (data.type === "redline:ready") {
        const selectors = manifest.links.filter((l) => l.from === current).map((l) => l.selector);
        frame.current?.contentWindow?.postMessage({ type: "redline:set-links", selectors }, "*");
        setBridgeEpoch((n) => n + 1);
      } else if (data.type === "redline:link" && data.selector !== undefined) {
        const target = resolveLink(manifest, pageId, current, data.selector);
        if (target === null) return;
        if (target.page === null) showArtboard(target.file, "push");
        else followOtherPage(target.page, target.file);
      } else if (data.type === "redline:picked") {
        setPicked(data as Pick);
        setCommenting(false);
      } else if (data.type === "redline:top-colour" && typeof data.colour === "string") {
        setTopColour(data.colour);
      } else if (data.type === "redline:key" && (data.key === "ArrowLeft" || data.key === "ArrowRight")) {
        goBy(data.key === "ArrowLeft" ? -1 : 1);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [manifest, tocItems, current, renderingParam]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (menuOpen) setMenuOpen(false);
        else onExit();
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !menuOpen && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !isEditableTarget(event.target)) goBy(event.key === "ArrowLeft" ? -1 : 1);
      else if (event.key.toLowerCase() === "g" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) onToggleGuides();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit, onToggleGuides, menuOpen, tocItems, current, renderingParam]);

  /** The shown artboard's tweaks, plus the page tweaks bound to no artboard. */
  const shownTweaks = manifest.tweaks.filter((tweak) => tweak.artboard === undefined || tweak.artboard === current);
  async function sendComment(visitorName: string) {
    if (!picked) return;
    const request: CreateThreadRequest = {
      artboard: current,
      selector: picked.selector,
      xPct: picked.xPct,
      yPct: picked.yPct,
      ...(picked.elementName ? { elementName: picked.elementName } : {}),
      ...(rendering ? { rendering: { format: rendering.format, width: rendering.width } } : {}),
      ...(picked.instanceState ? { instanceState: picked.instanceState } : {}),
      body: commentText,
      visitorName,
    };
    await fetch(`/api/pages/${pageId}/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    setPicked(null);
    setCommentText("");
  }
  const hasTweaks = shownTweaks.length > 0 && !presentation?.mobileBar && !phoneVisitor && (visitor === null || visitor.view.level === "write");
  return (
    <div data-testid="play" className={styles.play}>
      {phoneVisitor ? (
        <header className={styles.visitorTop}>
          <div className={styles.visitorTitle}>
            <strong>{artboard?.title ?? artboard?.file}</strong>
            <span>
              {pageTitle} · {position + 1} / {tocItems.length}
            </span>
          </div>
          <StatusBadge tone={visitor.view.level === "write" ? "accent" : "neutral"}>{linkBadgeLabel(visitor.view)}</StatusBadge>
        </header>
      ) : presentation?.mobileBar ? (
        <header className={styles.mobileBar}>
          <Tooltip label="Retour au canvas">
            <button type="button" onClick={onExit} aria-label="Retour au canvas" className={styles.mobileBack}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </button>
          </Tooltip>
          <span className={styles.mobileTitle}>
            {pageTitle} · {artboard?.title ?? artboard?.file}
          </span>
          {renderings.length > 0 && (
            <span className={styles.mobileRenderingWrap}>
              <select
                aria-label="Rendu responsive"
                value={rendering ? renderingKey(rendering) : NO_RENDERING_OPTION}
                onChange={(event) => chooseRendering(renderings.find((r) => renderingKey(r) === event.target.value) ?? null)}
                className={styles.mobileRendering}
              >
                {renderings.map((r) => (
                  <option key={renderingKey(r)} value={renderingKey(r)}>
                    {renderingOptionLabel(r)}
                  </option>
                ))}
                <option value={NO_RENDERING_OPTION}>Aucun</option>
              </select>
              <svg className={styles.mobileRenderingChevron} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          )}
          <nav aria-label="Artboards" className={styles.mobileSteps}>
            <PlayStepper variant="phone" tocItems={tocItems} current={current} menuOpen={menuOpen} onMenuOpenChange={setMenuOpen} goBy={goBy} onChoose={(file) => showArtboard(file, "replace")} />
          </nav>
        </header>
      ) : (
        <header className={styles.topbar}>
          <div className={styles.leading}>
            <button type="button" onClick={onExit} title="Échap" className={styles.back}>
              ← Canvas
            </button>
            <div className={styles.title}>{pageTitle} · {artboard?.title ?? artboard?.file}</div>
          {renderings.length > 0 && (
            <div role="group" aria-label="Rendu responsive" className={styles.renderings}>
              {[...renderings, null].map((r) => (
                <button
                  key={r ? renderingKey(r) : "none"}
                  type="button"
                  aria-pressed={r === rendering}
                  onClick={() => chooseRendering(r)}
                  className={cx(styles.rendering, r === rendering && styles.renderingCurrent)}
                >
                  {r ? renderingOptionLabel(r) : "Aucun"}
                </button>
              ))}
            </div>
          )}
          </div>
          <nav aria-label="Artboards" className={styles.screens}>
            <PlayStepper variant="header" tocItems={tocItems} current={current} menuOpen={menuOpen} onMenuOpenChange={setMenuOpen} goBy={goBy} onChoose={(file) => showArtboard(file, "replace")} />
          </nav>
          <div className={styles.actions}>
          <span className={styles.copyWrap}>
            {copied !== null && (
              <div role="status" className={styles.copiedBubble}>
                Lien copié
              </div>
            )}
            <button type="button" onClick={copyPlayUrl} className={styles.actionButton}>
              <CopyLinkIcon />
              Copier le lien
            </button>
          </span>
          {presentation?.framable && (
            <button type="button" aria-pressed={framed} title={isBrowserFrame ? "Afficher ou masquer la fenêtre de navigateur" : "Afficher ou masquer le cadre de l'appareil"} onClick={toggleFramed} className={cx(styles.habillage, framed && styles.habillageOn)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {isBrowserFrame ? (
                  <>
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M3 9h18" />
                  </>
                ) : (
                  <>
                    <rect x="6" y="2" width="12" height="20" rx="3" />
                    <path d="M11 18h2" />
                  </>
                )}
              </svg>
              Habillage
            </button>
          )}
          {artboard?.guides && <GuidesButton pressed={guidesVisible} onToggle={onToggleGuides} className={cx(styles.guidesButton, guidesVisible && styles.guidesButtonOn)} />}
          {hasTweaks && (
            <button type="button" aria-pressed={tweaksOpen} onClick={toggleTweaks} className={cx(styles.tweaksButton, tweaksOpen && styles.tweaksButtonOn)}>
              Tweaks
            </button>
          )}
          </div>
        </header>
      )}
      <div className={styles.body}>
        <main ref={stage} data-frame={presentation?.frame} data-fill={presentation?.fill === "none" ? undefined : presentation?.fill} className={styles.stage}>
          {artboard && presentation && fitted ? (
            <PlayFrame frame={presentation.frame} url={artboard.url} statusColour={topColour ?? undefined}>
              <div className={styles.viewport} style={{ width: fitted.viewport.width * fitted.scale, height: fitted.viewport.height * fitted.scale }}>
                <ArtboardIframe
                  key={artboard.file}
                  ref={frame}
                  title={`Plein écran / ${artboard.file}`}
                  src={`${artboardOrigin}/pages/${pageId}/${artboard.file}`}
                  sandbox="allow-scripts"
                  className={styles.frame}
                  style={{ width: fitted.viewport.width, height: fitted.viewport.height, transform: `scale(${fitted.scale})` }}
                />
                {guidesVisible && artboard.guides && (
                  <div className={styles.guides} style={{ width: fitted.viewport.width, height: fitted.viewport.height, transform: `scale(${fitted.scale})` }}>
                    <ArtboardGuides guides={artboard.guides} />
                  </div>
                )}
              </div>
            </PlayFrame>
          ) : (
            <p className={styles.empty}>Aucun artboard</p>
          )}
        </main>
        {deadLink !== null && (
          <MissingArtboardNotice file={deadLink} onClose={() => setDeadLink(null)} className={styles.deadLink} />
        )}
        {hasTweaks && tweaksOpen && (
          <aside aria-label="Tweaks" className={styles.aside}>
            <div className={styles.asideHead}>
              <div className={styles.asideTitle}>Tweaks</div>
              <div className={styles.asideHint}>Réglages déclarés par Claude dans le manifeste. Ils s'appliquent tout de suite, sans session.</div>
            </div>
            <TweaksPanel
              theme="dark"
              tweaks={shownTweaks}
              values={tweaks}
              onChange={onTweak}
              previews={artboard && { pageId, artboardOrigin, artboard }}
            />
            <div className={styles.spacer} />
            <div className={styles.asideNote}>Les valeurs choisies font partie du design : elles sont enregistrées avec l'artefact et s'appliquent aussi sur le canvas.</div>
          </aside>
        )}
      </div>
      {canComment && commenting && (
        <p role="status" className={styles.visitorHint}>
          Touche l'élément à commenter.
        </p>
      )}
      {canComment && picked && (
        <div className={styles.sheet}>
          <VisitorComposer
            visitor={visitor}
            label={picked.elementName ?? picked.selector}
            text={commentText}
            onText={setCommentText}
            onSend={sendComment}
            onCancel={() => {
              setPicked(null);
              setCommentText("");
            }}
          />
        </div>
      )}
      {canComment && listOpen && (
        <div className={styles.sheet}>
          <section aria-label={writing ? "Commentaires" : "Commentaires de ce lien"} className={styles.sheetList}>
            <header className={styles.sheetHead}>
              <h2>{writing ? "Commentaires" : "Commentaires de ce lien"} · {linkThreads.length}</h2>
              <button type="button" aria-label="Fermer" onClick={() => setListOpen(false)} className={styles.sheetClose}>
                ×
              </button>
            </header>
            <VisitorThreadCards threads={writing ? [...linkThreads].reverse() : linkThreads} visitor={visitor} artboardTitles={Object.fromEntries(manifest.artboards.map((a) => [a.file, a.title ?? a.file]))} claudeAvailable={claudeAvailable} />
          </section>
        </div>
      )}
      {phoneVisitor && (
        <nav aria-label="Artboards" className={styles.visitorBottom}>
          <button type="button" aria-label="Écran précédent" disabled={position <= 0} onClick={() => goBy(-1)} className={cx(styles.visitorStep, canComment && styles.visitorStepNarrow)}>
            ‹
          </button>
          {canComment && (
            <>
              <button type="button" aria-pressed={commenting} onClick={() => { setCommenting(!commenting); setListOpen(false); }} className={cx(styles.visitorAction, styles.visitorActionMain, commenting && styles.visitorActionOn)}>
                Commenter
              </button>
              <button type="button" onClick={() => { setListOpen(true); setCommenting(false); }} className={styles.visitorAction}>
                Commentaires · {linkThreads.length}
              </button>
            </>
          )}
          <button type="button" aria-label="Écran suivant" disabled={position >= tocItems.length - 1} onClick={() => goBy(1)} className={cx(styles.visitorStep, canComment && styles.visitorStepNarrow)}>
            ›
          </button>
        </nav>
      )}
    </div>
  );
}
