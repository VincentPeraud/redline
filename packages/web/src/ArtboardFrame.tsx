import { useEffect, useRef, useState } from "react";
import type { ArtboardGuides as Guides, Thread, TweakValues } from "@redline/shared";
import { ArtboardGuides } from "./ArtboardGuides.js";
import { threadWhere } from "./threadLabel.js";
import { cx } from "./ui/index.js";
import styles from "./ArtboardFrame.module.css";
import { useAltKey } from "./useAltKey.js";

export interface Pick {
  selector: string;
  elementName?: string;
  xPct: number;
  yPct: number;
}

interface ForwardedWheel {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
}

interface PinPosition {
  id: string;
  xPct: number;
  yPct: number;
  matched: boolean;
}

interface Props {
  src: string;
  title: string;
  width: number;
  height: number;
  /** Canvas zoom; pins are counter-scaled so they keep their size. */
  zoom: number;
  /** Layout guides to draw over the artboard; absent when hidden or not declared. */
  guides?: Guides;
  threads: Thread[];
  picking: boolean;
  tweaks: TweakValues;
  onPick: (pick: Pick) => void;
  /** Called with the real height of the artboard's page whenever the bridge reports it. */
  onDocHeight?: (height: number) => void;
}

/**
 * The artboard iframe is sandboxed with an opaque origin: we cannot read its DOM, so picking
 * and pin placement go through the bridge script the server injects (see conventions.md).
 * Messages are trusted only when `event.source` is this iframe's window.
 */
export function ArtboardFrame({ src, title, width, height, zoom, guides, threads, picking, tweaks, onPick, onDocHeight }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const alt = useAltKey();
  const [positions, setPositions] = useState<PinPosition[]>([]);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onDocHeightRef = useRef(onDocHeight);
  onDocHeightRef.current = onDocHeight;

  const pinned = threads;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string } & Partial<Pick> & { positions?: PinPosition[] };
      if (data.type === "redline:ready") setBridgeEpoch((n) => n + 1);
      else if (data.type === "redline:picked") onPickRef.current(data as Pick);
      else if (data.type === "redline:pin-positions") setPositions(data.positions ?? []);
      else if (data.type === "redline:doc-height") onDocHeightRef.current?.((data as unknown as { height: number }).height);
      else if (data.type === "redline:wheel") replayWheel(data as unknown as ForwardedWheel);
    }
    // The iframe swallows wheel and pinch: the bridge hands them back, and we replay them on the iframe
    // element so they bubble to the canvas, with the cursor mapped from artboard to page coordinates.
    function replayWheel(wheel: ForwardedWheel) {
      const element = frame.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const scale = rect.width / element.offsetWidth || 1;
      element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: wheel.deltaX,
          deltaY: wheel.deltaY,
          deltaMode: wheel.deltaMode,
          ctrlKey: wheel.ctrlKey,
          metaKey: wheel.metaKey,
          clientX: rect.left + wheel.clientX * scale,
          clientY: rect.top + wheel.clientY * scale,
        }),
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-mode", picking, alt, forwardWheel: true }, "*");
  }, [picking, alt, bridgeEpoch]);

  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-tweaks", values: tweaks }, "*");
  }, [tweaks, bridgeEpoch]);

  const pinsKey = JSON.stringify(pinned.map((t) => [t.id, t.selector, t.xPct, t.yPct]));
  useEffect(() => {
    if (bridgeEpoch === 0) return;
    const pins = pinned.map((t) => ({ id: t.id, selector: t.selector, xPct: t.xPct, yPct: t.yPct }));
    frame.current?.contentWindow?.postMessage({ type: "redline:set-pins", pins }, "*");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsKey, bridgeEpoch]);

  return (
    <div className={styles.frame} style={{ width, height }}>
      <div className={styles.clip} style={{ width, height }}>
        <iframe ref={frame} title={title} src={src} sandbox="allow-scripts" className={styles.iframe} style={{ width, height }} />
        {guides && <ArtboardGuides guides={guides} />}
      </div>
      {pinned.map((thread) => {
        const position = positions.find((p) => p.id === thread.id) ?? thread;
        const resolved = thread.status === "resolved";
        return (
          <span
            key={thread.id}
            data-pin={thread.number}
            title={`${thread.title} · ${threadWhere(thread)}`}
            className={cx(styles.pin, thread.status === "held" && styles.pinHeld, resolved && styles.pinResolved)}
            style={{ left: `${position.xPct}%`, top: `${position.yPct}%`, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
          >
            {resolved ? "✓" : thread.number}
          </span>
        );
      })}
    </div>
  );
}
