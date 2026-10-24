import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RESPONSIVE_FORMATS, renderingKey, renderingLabel, type ArtboardRendering, type Manifest, type TweakValue, type TweakValues } from "@redline/shared";
import { PlayStepper } from "./PlayStepper.js";
import type { TocItem } from "./tocItems.js";
import { TweaksPanel } from "./TweaksPanel.js";
import { PlayFrame } from "./PlayFrame.js";
import { presentationOf, type Presentation } from "./playFrames.js";
import { ArtboardGuides } from "./ArtboardGuides.js";
import { GuidesButton } from "./GuidesButton.js";
import { isEditableTarget } from "./isEditableTarget.js";
import { useStoredToggle } from "./useStoredToggle.js";
import { renduOf, usePlayRendering } from "./usePlayRendering.js";
import { navigateTo } from "./router.js";
import { loadPageSummary } from "./otherPageArtboards.js";
import { COPIED_BUBBLE_MS, copyAddress } from "./copyLink.js";
import { cx } from "./ui/index.js";
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

const NO_RENDERING = "none";

interface Props {
  pageId: string;
  pageTitle: string;
  manifest: Manifest;
  /** The artboards in reading order: the counter, the arrows and the contents menu follow it. */
  tocItems: TocItem[];
  /** Artboard shown: the file of the play address. */
  file: string;
  /** The play address's `rendu` value, as written. */
  rendu?: string;
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
export function PlayMode({ pageId, pageTitle, manifest, tocItems, file: current, rendu, artboardOrigin, tweaks, onTweak, guidesVisible, onToggleGuides, onExit }: Props) {
  const [copied, setCopied] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deadLink, setDeadLink] = useState<string | null>(null);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const artboard = manifest.artboards.find((a) => a.file === current);
  const [framed, toggleFramed] = useStoredToggle("redline:play-framed", true);
  const [tweaksOpen, toggleTweaks] = useStoredToggle("redline:play-tweaks", true);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const renderings = artboard?.responsive ?? [];
  const [rendering, selectRendering] = usePlayRendering(renderings, rendu);
  const presentation = artboard && presentationOf(artboard, framed, windowWidth, artboard.responsive ? rendering : undefined);
  const isBrowserFrame = rendering ? rendering.format === "desktop" : artboard?.frame === "browser";
  const fitted = presentation && fitToStage(presentation, stageSize);
  const playRoute = (file: string, renduValue: string | undefined) => ({ name: "page" as const, pageId, play: file, ...(renduValue === undefined ? {} : { rendu: renduValue }) });
  /** A link the user followed pushes an entry; the header buttons replace the current one. */
  const showArtboard = (file: string, mode: "push" | "replace") => navigateTo(playRoute(file, rendu), mode);
  const position = tocItems.findIndex((item) => item.file === current);
  const goBy = (step: -1 | 1) => {
    const target = tocItems[position + step];
    if (target) showArtboard(target.file, "replace");
  };
  /** The target page's manifest and tweaks load with its own play route; a gone page or artboard leaves the screen as it is. */
  const followOtherPage = (otherPageId: string, file: string) =>
    void loadPageSummary(otherPageId).then((summary) => {
      if (summary?.artboardTitles.has(file)) navigateTo({ name: "page", pageId: otherPageId, play: file }, "push");
      else setDeadLink(file);
    });
  const chooseRendering =(choice: ArtboardRendering | null) => {
    selectRendering(choice);
    navigateTo(playRoute(current, renduOf(choice)), "replace");
  };
  const copyPlayUrl = () => void copyAddress(playRoute(current, renderings.length > 0 ? renduOf(rendering) : undefined)).then(() => setCopied(Date.now()));
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
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_BUBBLE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

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
      const data = event.data as { type?: string; selector?: string; key?: string };
      if (data.type === "redline:ready") {
        const selectors = manifest.links.filter((l) => l.from === current).map((l) => l.selector);
        frame.current?.contentWindow?.postMessage({ type: "redline:set-links", selectors }, "*");
        setBridgeEpoch((n) => n + 1);
      } else if (data.type === "redline:link" && data.selector !== undefined) {
        const target = resolveLink(manifest, pageId, current, data.selector);
        if (target === null) return;
        if (target.page === null) showArtboard(target.file, "push");
        else followOtherPage(target.page, target.file);
      } else if (data.type === "redline:key" && (data.key === "ArrowLeft" || data.key === "ArrowRight")) {
        goBy(data.key === "ArrowLeft" ? -1 : 1);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [manifest, tocItems, current, rendu]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (menuOpen) setMenuOpen(false);
        else onExit();
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !isEditableTarget(event.target)) goBy(event.key === "ArrowLeft" ? -1 : 1);
      else if (event.key.toLowerCase() === "g" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) onToggleGuides();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit, onToggleGuides, menuOpen, tocItems, current, rendu]);

  const hasTweaks = manifest.tweaks.length > 0 && !presentation?.mobileBar;
  return (
    <div data-testid="play" className={styles.play}>
      {presentation?.mobileBar ? (
        <header className={styles.mobileBar}>
          <button type="button" onClick={onExit} aria-label="Retour au canvas" className={styles.mobileBack}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <span className={styles.mobileTitle}>
            {pageTitle} · {artboard?.title ?? artboard?.file}
          </span>
          {renderings.length > 0 && (
            <span className={styles.mobileRenderingWrap}>
              <select
                aria-label="Rendu responsive"
                value={rendering ? renderingKey(rendering) : NO_RENDERING}
                onChange={(event) => chooseRendering(renderings.find((r) => renderingKey(r) === event.target.value) ?? null)}
                className={styles.mobileRendering}
              >
                {renderings.map((r) => (
                  <option key={renderingKey(r)} value={renderingKey(r)}>
                    {renderingOptionLabel(r)}
                  </option>
                ))}
                <option value={NO_RENDERING}>Aucun</option>
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
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
              </svg>
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
            <PlayFrame frame={presentation.frame} url={artboard.url}>
              <div className={styles.viewport} style={{ width: fitted.viewport.width * fitted.scale, height: fitted.viewport.height * fitted.scale }}>
                <iframe
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
          <div role="status" className={styles.deadLink}>
            Cet artboard n'existe plus · {deadLink}
            <button type="button" aria-label="Fermer" className={styles.deadLinkClose} onClick={() => setDeadLink(null)}>
              ×
            </button>
          </div>
        )}
        {hasTweaks && tweaksOpen && (
          <aside aria-label="Tweaks" className={styles.aside}>
            <div className={styles.asideHead}>
              <div className={styles.asideTitle}>Tweaks</div>
              <div className={styles.asideHint}>Réglages déclarés par Claude dans le manifeste. Ils s'appliquent tout de suite, sans session.</div>
            </div>
            <TweaksPanel
              theme="dark"
              tweaks={manifest.tweaks}
              values={tweaks}
              onChange={onTweak}
              previews={manifest.artboards[0] && { pageId, artboardOrigin, artboard: manifest.artboards[0] }}
            />
            <div className={styles.spacer} />
            <div className={styles.asideNote}>Les valeurs choisies font partie du design : elles sont enregistrées avec l'artefact et s'appliquent aussi sur le canvas.</div>
          </aside>
        )}
      </div>
    </div>
  );
}
