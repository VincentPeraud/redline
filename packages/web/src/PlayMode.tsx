import { useEffect, useRef, useState } from "react";
import type { Manifest, TweakValue, TweakValues } from "@redline/shared";
import { TweaksPanel } from "./TweaksPanel.js";

/** Target artboard of the link on `selector` in artboard `from`, if the manifest declares one that exists. */
export function resolveLink(manifest: Manifest, from: string, selector: string): string | null {
  const link = manifest.links.find((l) => l.from === from && l.selector === selector);
  if (!link) return null;
  return manifest.artboards.some((a) => a.file === link.to) ? link.to : null;
}

interface Props {
  pageId: string;
  manifest: Manifest;
  artboardOrigin: string;
  tweaks: TweakValues;
  onTweak: (id: string, value: TweakValue) => void;
  onExit: () => void;
}

/** One artboard at a time at full size; clicks on elements linked in the manifest switch artboard (via the bridge). */
export function PlayMode({ pageId, manifest, artboardOrigin, tweaks, onTweak, onExit }: Props) {
  const [current, setCurrent] = useState(manifest.artboards[0]?.file ?? null);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const artboard = manifest.artboards.find((a) => a.file === current);

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

  return (
    <div data-testid="play" style={{ background: "#f2f2f0", padding: 16 }}>
      <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onExit}>← Canvas (Échap)</button>
        <span>{artboard?.title ?? artboard?.file ?? "Aucun artboard"}</span>
      </div>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <TweaksPanel tweaks={manifest.tweaks} values={tweaks} onChange={onTweak} />
        {artboard && (
        <div style={{ overflow: "auto", flex: 1 }}>
          <iframe
            key={artboard.file}
            ref={frame}
            title={`Plein écran / ${artboard.file}`}
            src={`${artboardOrigin}/pages/${pageId}/${artboard.file}`}
            sandbox="allow-scripts"
            style={{ width: artboard.width, height: artboard.height, border: 0, background: "#fff", display: "block", margin: "0 auto" }}
          />
        </div>
        )}
      </div>
    </div>
  );
}
