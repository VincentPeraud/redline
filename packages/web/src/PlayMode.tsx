import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Manifest, TweakValue, TweakValues } from "@redline/shared";
import { TweaksPanel } from "./TweaksPanel.js";
import { PlayDevice } from "./PlayDevice.js";
import { presentationOf, type Presentation } from "./playDevices.js";
import { usePlayFramed } from "./usePlayFramed.js";
import { cx } from "./ui/index.js";
import styles from "./PlayMode.module.css";

/** Target artboard of the link on `selector` in artboard `from`, if the manifest declares one that exists. */
export function resolveLink(manifest: Manifest, from: string, selector: string): string | null {
  const link = manifest.links.find((l) => l.from === from && l.selector === selector);
  if (!link) return null;
  return manifest.artboards.some((a) => a.file === link.to) ? link.to : null;
}

interface Props {
  pageId: string;
  manifest: Manifest;
  /** Artboard shown first. */
  start?: string;
  artboardOrigin: string;
  tweaks: TweakValues;
  onTweak: (id: string, value: TweakValue) => void;
  onExit: () => void;
}

/** Viewport and scale that fit the presentation on the stage; a `fill` presentation stretches to the stage instead. */
function fitToStage(presentation: Presentation, stage: { width: number; height: number }) {
  const { viewport, fill, stagePadding, frameHeight } = presentation;
  if (fill === "both") return { viewport: stage, scale: 1 };
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
export function PlayMode({ pageId, manifest, start, artboardOrigin, tweaks, onTweak, onExit }: Props) {
  const [current, setCurrent] = useState(start ?? manifest.artboards[0]?.file ?? null);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const artboard = manifest.artboards.find((a) => a.file === current);
  const [framed, toggleFramed] = usePlayFramed();
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const presentation = artboard && presentationOf(artboard, framed, windowWidth);
  const fitted = presentation && stageSize.width > 0 ? fitToStage(presentation, stageSize) : null;

  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
      if (event.source !== frame.current?.contentWindow || current === null) return;
      const data = event.data as { type?: string; selector?: string };
      if (data.type === "redline:ready") {
        const selectors = manifest.links.filter((l) => l.from === current).map((l) => l.selector);
        frame.current?.contentWindow?.postMessage({ type: "redline:set-links", selectors }, "*");
        setBridgeEpoch((n) => n + 1);
      } else if (data.type === "redline:link" && data.selector !== undefined) {
        const target = resolveLink(manifest, current, data.selector);
        if (target !== null) setCurrent(target);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [manifest, current]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onExit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  const hasTweaks = manifest.tweaks.length > 0 && !presentation?.mobileBar;
  return (
    <div data-testid="play" className={styles.play}>
      {presentation?.mobileBar ? (
        <header className={styles.mobileBar}>
          <button type="button" onClick={onExit} aria-label="Retour au canvas" className={styles.mobileBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <span className={styles.mobileTitle}>
            {manifest.title ?? "Sans titre"} · {artboard?.file}
          </span>
        </header>
      ) : (
        <header className={styles.topbar}>
          <button type="button" onClick={onExit} title="Échap" className={styles.back}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
            Canvas
          </button>
          <div className={styles.title}>{manifest.title ?? "Sans titre"} · plein écran</div>
          <div className={styles.spacer} />
          <nav aria-label="Artboards" className={styles.screens}>
            {manifest.artboards.map((a, index) => (
              <button
                key={a.file}
                type="button"
                title={a.title ?? a.file}
                aria-current={a.file === current ? "page" : undefined}
                onClick={() => setCurrent(a.file)}
                className={cx(styles.screen, a.file === current && styles.screenCurrent)}
              >
                Artboard {index + 1}
              </button>
            ))}
          </nav>
          <div className={styles.spacer} />
          {presentation?.framable && (
            <button type="button" aria-pressed={framed} title={artboard?.device === "desktop" ? "Afficher ou masquer la fenêtre de navigateur" : "Afficher ou masquer le cadre de l'appareil"} onClick={toggleFramed} className={cx(styles.habillage, framed && styles.habillageOn)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {artboard?.device === "desktop" ? (
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
          {hasTweaks && <div className={styles.tweaksState}>Tweaks ouverts</div>}
        </header>
      )}
      <div className={styles.body}>
        <main ref={stage} data-device={presentation?.device} data-fill={presentation?.fill === "none" ? undefined : presentation?.fill} className={styles.stage}>
          {artboard && presentation && fitted ? (
            <PlayDevice device={presentation.device} url={artboard.url}>
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
              </div>
            </PlayDevice>
          ) : (
            <p className={styles.empty}>Aucun artboard</p>
          )}
        </main>
        {hasTweaks && (
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
