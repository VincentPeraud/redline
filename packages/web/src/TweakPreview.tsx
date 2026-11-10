import { ArtboardIframe } from "./artboardCapability.js";
import { useEffect, useRef, useState } from "react";
import type { ManifestArtboard, TweakValues } from "@redline/shared";
import styles from "./TweaksPanel.module.css";

export interface PreviewSource {
  pageId: string;
  artboardOrigin: string;
  artboard: ManifestArtboard;
}

const THUMB_WIDTH = 58;
const THUMB_HEIGHT = 100;

/** Live thumbnail of an artboard rendered with `values`: a scaled, non-interactive iframe fed through the bridge. */
export function TweakPreview({ source, values }: { source: PreviewSource; values: TweakValues }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const { artboard } = source;
  const scale = Math.min(THUMB_WIDTH / artboard.width, THUMB_HEIGHT / artboard.height);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source === frame.current?.contentWindow && (event.data as { type?: string }).type === "redline:ready") setReady(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: "redline:set-tweaks", values }, "*");
  }, [ready, values]);

  return (
    <span className={styles.previewThumb} aria-hidden="true">
      <ArtboardIframe
        ref={frame}
        tabIndex={-1}
        title={`Aperçu / ${artboard.file}`}
        src={`${source.artboardOrigin}/pages/${source.pageId}/${artboard.file}`}
        sandbox="allow-scripts"
        className={styles.previewFrame}
        style={{ width: artboard.width, height: artboard.height, transform: `scale(${scale})`, left: (THUMB_WIDTH - artboard.width * scale) / 2 }}
      />
    </span>
  );
}
