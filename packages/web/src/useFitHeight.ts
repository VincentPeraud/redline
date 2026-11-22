import { MAX_FIT_HEIGHT, type ManifestArtboard } from "@redline/shared";
import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Next height of a `height: "fit"` artboard once its page reported `reported`, or undefined to keep `current`.
 * A page that grows with its own viewport (100vh plus a margin) would grow forever: a growth seen twice in a row, or past the cap, is ignored.
 */
export function nextFitHeight(current: number, reported: number, lastGrowth: number | undefined): { height: number; growth: number } | undefined {
  const growth = reported - current;
  if (growth === 0) return undefined;
  if (growth > 0 && (lastGrowth === growth || reported > MAX_FIT_HEIGHT)) return undefined;
  return { height: reported, growth };
}

/**
 * The artboard as shown full size: a `height: "fit"` one takes the height its page reports (the manifest only holds a placeholder),
 * as it does on the canvas. Any other artboard is returned unchanged.
 */
export function useFitHeight<T extends Pick<ManifestArtboard, "height" | "fitHeight">>(artboard: T | undefined, frame: RefObject<HTMLIFrameElement | null>, key: string): T | undefined {
  const [measured, setMeasured] = useState<{ key: string; height: number }>();
  /** What was last applied for this key, read synchronously between two reports. */
  const applied = useRef<{ key: string; height: number; growth?: number }>();
  const fit = artboard?.fitHeight === true;
  const placeholder = artboard?.height ?? 0;
  useEffect(() => {
    if (!fit) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; height?: unknown };
      if (event.source !== frame.current?.contentWindow || data?.type !== "redline:doc-height" || typeof data.height !== "number") return;
      const reported = Math.max(1, Math.ceil(data.height));
      const known = applied.current?.key === key ? applied.current : undefined;
      const next = nextFitHeight(known?.height ?? placeholder, reported, known?.growth);
      if (!next) return;
      applied.current = { key, ...next };
      setMeasured({ key, height: next.height });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fit, frame, key, placeholder]);
  if (!artboard || !fit || measured?.key !== key) return artboard;
  return { ...artboard, height: measured.height };
}
