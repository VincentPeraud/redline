import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Manifest, TweakValue, TweakValues } from "@redline/shared";
import { TweaksPanel } from "./TweaksPanel.js";
import { cx } from "./ui/index.js";
import styles from "./PlayMode.module.css";

/** Artboards up to this width are drawn as a phone: rounded corners and a dark bezel. */
const PHONE_MAX_WIDTH = 500;
/** Portrait phone artboards play in a real phone viewport, so responsive designs reflow. */
const PHONE_VIEWPORT = { width: 390, height: 760 };
const STAGE_PADDING = 32;

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

/** One artboard at a time at full size; clicks on elements linked in the manifest switch artboard (via the bridge). */
export function PlayMode({ pageId, manifest, start, artboardOrigin, tweaks, onTweak, onExit }: Props) {
  const [current, setCurrent] = useState(start ?? manifest.artboards[0]?.file ?? null);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const artboard = manifest.artboards.find((a) => a.file === current);
  const isPhone = artboard !== undefined && artboard.width <= PHONE_MAX_WIDTH && artboard.height > artboard.width;
  const viewport = artboard && (isPhone ? PHONE_VIEWPORT : { width: artboard.width, height: artboard.height });
  const scale = viewport && stageSize.width > 0
    ? Math.min(1, Math.max(0.1, (stageSize.width - STAGE_PADDING * 2) / viewport.width), Math.max(0.1, (stageSize.height - STAGE_PADDING * 2) / viewport.height))
    : 1;

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

  const hasTweaks = manifest.tweaks.length > 0;
  const frameStyle = viewport && {
    width: viewport.width,
    height: viewport.height,
    transform: `scale(${scale})`,
  };

  return (
    <div data-testid="play" className={styles.play}>
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
        {hasTweaks && <div className={styles.tweaksState}>Tweaks ouverts</div>}
      </header>
      <div className={styles.body}>
        <main ref={stage} className={styles.stage}>
          {artboard && viewport && frameStyle ? (
            <div
              className={cx(styles.device, artboard.width <= PHONE_MAX_WIDTH && styles.phone)}
              style={{ width: viewport.width * scale, height: viewport.height * scale }}
            >
              <iframe
                key={artboard.file}
                ref={frame}
                title={`Plein écran / ${artboard.file}`}
                src={`${artboardOrigin}/pages/${pageId}/${artboard.file}`}
                sandbox="allow-scripts"
                className={styles.frame}
                style={frameStyle}
              />
            </div>
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
