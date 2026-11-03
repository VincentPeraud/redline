import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ArtboardGuides as Guides, Thread, TweakValues } from "@redline/shared";
import { ArtboardErrorsContext } from "./ArtboardErrors.js";
import { ArtboardGuides } from "./ArtboardGuides.js";
import { SeenGapContext } from "./GapsReport.js";
import { ReportMissingInstanceElementsContext } from "./InstanceThreads.js";
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

/** Opens a pin's thread in the side panel; without it, pins are only marks. */
export const PinClickContext = createContext<((threadId: string) => void) | undefined>(undefined);

interface PinPosition {
  id: string;
  xPct: number;
  yPct: number;
  matched: boolean;
  /** The element inside a component instance is gone: the pin sits on the instance. */
  elementGone?: boolean;
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
  /** The conversation's selection mode: hovers and picks like comment mode. */
  selecting: boolean;
  /** Numbered marks of the message's chips on this artboard, drawn by the bridge. */
  marks: { number: number; selector: string }[];
  tweaks: TweakValues;
  /** No rounded corners, shadow or background: the artboard sits straight on what is behind it (a tweak grid cell). */
  bare?: boolean;
  onPick: (pick: Pick) => void;
  /** Escape pressed inside the artboard while selecting (the iframe holds the keyboard focus). */
  onEscape?: () => void;
  /** Called with the real height of the artboard's page whenever the bridge reports it. */
  onDocHeight?: (height: number) => void;
}

/**
 * The artboard iframe is sandboxed with an opaque origin: we cannot read its DOM, so picking
 * and pin placement go through the bridge script the server injects (see conventions.md).
 * Messages are trusted only when `event.source` is this iframe's window.
 */
export function ArtboardFrame({ src, title, width, height, zoom, guides, threads, picking, selecting, marks, tweaks, bare, onPick, onEscape, onDocHeight }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const alt = useAltKey();
  const [positions, setPositions] = useState<PinPosition[]>([]);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const onDocHeightRef = useRef(onDocHeight);
  onDocHeightRef.current = onDocHeight;

  const pinned = threads;
  const onPinClick = useContext(PinClickContext);
  const { seen, onRect } = useContext(SeenGapContext);
  const onRectRef = useRef(onRect);
  onRectRef.current = onRect;
  const seenHere = seen !== null && seen.src === src ? seen : null;
  const frameId = useId();
  const reportErrors = useContext(ArtboardErrorsContext);
  const reportErrorsRef = useRef(reportErrors);
  reportErrorsRef.current = reportErrors;
  const reportMissing = useContext(ReportMissingInstanceElementsContext);
  const reportMissingRef = useRef(reportMissing);
  reportMissingRef.current = reportMissing;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string } & Partial<Pick> & { positions?: PinPosition[] };
      if (data.type === "redline:ready") setBridgeEpoch((n) => n + 1);
      else if (data.type === "redline:picked") onPickRef.current(data as Pick);
      else if (data.type === "redline:escape") onEscapeRef.current?.();
      else if (data.type === "redline:pin-positions") {
        const reported = data.positions ?? [];
        setPositions(reported);
        reportMissingRef.current(frameId, reported.filter((p) => p.elementGone).map((p) => p.id));
      }
      else if (data.type === "redline:doc-height") onDocHeightRef.current?.((data as unknown as { height: number }).height);
      else if (data.type === "redline:errors") reportErrorsRef.current(frameId, (data as unknown as { errors: string[] }).errors);
      else if (data.type === "redline:gap-rect") onRectRef.current(data as unknown as { x: number; y: number; width: number; height: number });
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
    return () => {
      window.removeEventListener("message", onMessage);
      reportErrorsRef.current(frameId, []);
      reportMissingRef.current(frameId, []);
    };
  }, [frameId]);

  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-mode", picking, selecting, alt, forwardWheel: true }, "*");
  }, [picking, selecting, alt, bridgeEpoch]);

  const marksKey = JSON.stringify(marks);
  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-marks", marks }, "*");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, bridgeEpoch]);

  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-tweaks", values: tweaks }, "*");
  }, [tweaks, bridgeEpoch]);

  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-gap", selector: seenHere?.selector ?? null }, "*");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenHere?.selector, seenHere?.nonce, bridgeEpoch]);

  const pinsKey = JSON.stringify(pinned.map((t) => [t.id, t.selector, t.xPct, t.yPct]));
  useEffect(() => {
    if (bridgeEpoch === 0) return;
    const pins = pinned.map((t) => ({ id: t.id, selector: t.selector, xPct: t.xPct, yPct: t.yPct }));
    frame.current?.contentWindow?.postMessage({ type: "redline:set-pins", pins }, "*");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsKey, bridgeEpoch]);

  return (
    <div className={styles.frame} style={{ width, height }}>
      <div className={cx(styles.clip, bare && styles.clipBare)} style={{ width, height }}>
        <iframe ref={frame} title={title} src={src} sandbox="allow-scripts" className={cx(styles.iframe, bare && styles.iframeBare)} style={{ width, height }} />
        {guides && <ArtboardGuides guides={guides} />}
      </div>
      {pinned.map((thread) => {
        const position = positions.find((p) => p.id === thread.id) ?? thread;
        return (
          <button
            type="button"
            key={thread.id}
            data-pin={thread.number}
            data-pin-thread={thread.id}
            title={`${thread.title} · ${threadWhere(thread)}`}
            aria-label={`Ouvrir le commentaire ${thread.number}`}
            disabled={!onPinClick}
            className={cx(styles.pin, thread.status === "held" && styles.pinHeld, thread.status === "resolved" && styles.pinResolved)}
            style={{ left: `${position.xPct}%`, top: `${position.yPct}%`, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
            onClick={() => onPinClick?.(thread.id)}
          >
            {thread.status === "resolved" ? "✓" : thread.number}
          </button>
        );
      })}
    </div>
  );
}
