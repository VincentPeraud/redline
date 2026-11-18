import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ReviewZoomBar, ZOOM_BAR_ROOM } from "./ReviewZoomBar.js";
import { HOVER_FINISH, type ChangeReviewStep, type ReviewPin, type ReviewZoneTarget } from "@redline/shared";
import { ArtboardIframe } from "./artboardCapability.js";
import { CanvasElements } from "./CanvasElements.js";
import { responsiveFrameBox, type Box } from "./canvasGeometry.js";
import { PinPopoverAt, type PinsController } from "./ReviewPins.js";
import { PIN_SHIFT, PinMarker, PinTooltip, overlayStyle, pinLabel } from "./ReviewPinParts.js";
import { personName } from "./ReviewRemark.js";
import { MAX_CANVAS_SCALE, canvasCrop, canvasElementAt, canvasViewBox, canvasZoneFromDrag, panCanvasView, zoomCanvasView, zoomLimits, type CanvasZoomView } from "./reviewCanvasRules.js";
import { pinOffsets, pinTargetLabel } from "./reviewPinRules.js";
import { cx } from "./ui/index.js";
import { useAltKey } from "./useAltKey.js";
import styles from "./ReviewScreen.module.css";

/** Canvas pixels kept around the targeted elements: about one gap between two artboards. */
const CROP_MARGIN = 240;
/** The crop is never shown wider than this (screen pixels), as in the mock-up. */
const MAX_CROP_WIDTH = 920;
/** Room the stage keeps around the crop for its tag (top) and the shortcuts reminder (bottom), and on the sides. */
const STAGE_INSET = { x: 48, y: 72 };
const PHONE_STAGE_INSET = { x: 16, y: 64 };
/** One click on + or − (as on the page canvas). */
const ZOOM_STEP = 1.25;
/** Pixels per line of a wheel that scrolls by lines (Firefox with a mouse). */
const LINE_HEIGHT = 16;

type Point = { x: number; y: number };

/** Boxes (canvas pixels) of the targeted elements, read from the drawn elements: their size depends on the text and fonts, which only the browser knows. */
function measureTargets(world: HTMLElement, ids: readonly string[], scale: number): Map<string, Box> {
  const origin = world.getBoundingClientRect();
  const boxes = new Map<string, Box>();
  for (const id of ids) {
    const node = world.querySelector(`[data-canvas-element-id="${CSS.escape(id)}"]`);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    boxes.set(id, { x: (rect.left - origin.left) / scale, y: (rect.top - origin.top) / scale, width: rect.width / scale, height: rect.height / scale });
  }
  return boxes;
}

const sameBoxes = (a: ReadonlyMap<string, Box>, b: ReadonlyMap<string, Box>) => a.size === b.size && [...a].every(([id, box]) => b.get(id) && JSON.stringify(b.get(id)) === JSON.stringify(box));

/**
 * The page canvas cropped on the elements a step points at (see the "canevas" mock-up): the other artboards dimmed, the targeted elements framed and numbered,
 * pins and zones over it. Alt + click pins a targeted element, Alt + drag draws a zone; otherwise a drag or the wheel moves the shown piece and Cmd + wheel zooms.
 */
export function ReviewCanvas({ step, origin, stage, pins, phone, markersShown, firstFrame = 1 }: { firstFrame?: number; step: ChangeReviewStep; origin: string; stage: { width: number; height: number }; pins: PinsController; phone: boolean; markersShown: boolean }) {
  const canvas = step.canvas!;
  const targetIds = step.canvasElements ?? [];
  const alt = useAltKey();
  const world = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const applied = useRef(1);
  const [boxes, setBoxes] = useState<ReadonlyMap<string, Box>>(new Map());
  const [measured, setMeasured] = useState(false);
  const [drawing, setDrawing] = useState<ReviewZoneTarget | undefined>();
  const [hovered, setHovered] = useState<string | undefined>();
  const gesture = useRef<{ start: Point; altKey: boolean } | undefined>();
  /** A plain drag on the canvas: the pointer doing it and its last position, in screen pixels. */
  const panning = useRef<{ id: number; at: Point } | undefined>();
  const [panActive, setPanActive] = useState(false);
  const [view, setView] = useState<CanvasZoomView | undefined>();

  const artboardBoxes = useMemo(
    () => new Map<string, Box>(canvas.artboards.map((artboard) => [artboard.file, artboard.responsive ? responsiveFrameBox({ x: artboard.x, y: artboard.y, responsive: artboard.responsive }) : { x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height }])),
    [canvas.artboards],
  );
  const present = targetIds.filter((id) => !canvas.missing.includes(id));
  const allGone = present.length === 0;
  const pageBox = useMemo(() => {
    const all = [...artboardBoxes.values()];
    if (all.length === 0) return undefined;
    const left = Math.min(...all.map((box) => box.x));
    const top = Math.min(...all.map((box) => box.y));
    return canvasCrop([{ x: left, y: top, width: Math.max(...all.map((box) => box.x + box.width)) - left, height: Math.max(...all.map((box) => box.y + box.height)) - top }], undefined, CROP_MARGIN / 2);
  }, [artboardBoxes]);
  const crop = canvasCrop(
    present.flatMap((id) => (boxes.get(id) ? [boxes.get(id)!] : [])),
    pageBox,
    CROP_MARGIN,
  );
  const inset = phone ? PHONE_STAGE_INSET : STAGE_INSET;
  const avail = { width: Math.max(0, stage.width - inset.x * 2), height: Math.max(0, stage.height - inset.y * 2) };
  const scale = Math.max(0.05, Math.min(MAX_CANVAS_SCALE, MAX_CROP_WIDTH / crop.width, avail.width / crop.width || 1, avail.height / crop.height || 1));
  const size = { width: crop.width * scale, height: crop.height * scale };
  // The person's zoom: the frame keeps its size, the piece of canvas in it changes.
  const shown = canvasViewBox(crop, view);
  const shownScale = scale * (view?.zoom ?? 1);
  const limits = zoomLimits(crop, pageBox, scale);
  applied.current = measured ? shownScale : 1;
  const toScreen = (point: Point): Point => ({ x: (point.x - shown.x) * shownScale, y: (point.y - shown.y) * shownScale });
  const boxOnScreen = (box: Box) => ({ ...toScreen(box), width: box.width * shownScale, height: box.height * shownScale });
  const zoomBy = (factor: number, cursor: Point = { x: size.width / 2, y: size.height / 2 }) => setView((current) => zoomCanvasView(current, factor, cursor, scale, limits));
  const zoomLatest = useRef(zoomBy);
  zoomLatest.current = zoomBy;
  const panLatest = useRef((dx: number, dy: number) => setView((current) => panCanvasView(current, dx, dy, scale)));
  panLatest.current = (dx: number, dy: number) => setView((current) => panCanvasView(current, dx, dy, scale));

  // Each step opens on its own framing.
  const stepKey = JSON.stringify([step.pageId, targetIds]);
  useLayoutEffect(() => setView(undefined), [stepKey]);

  // Wheel: Cmd or Ctrl + wheel (and the trackpad pinch) zooms under the cursor, the wheel alone pans. Needs a non-passive listener.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? LINE_HEIGHT : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey) zoomLatest.current(Math.exp(-dy * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      else panLatest.current(-dx, -dy);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  // The crop follows the elements where they are drawn now: measured once drawn, again when fonts load or an element changes size.
  const elementsKey = JSON.stringify([targetIds, canvas.elements]);
  useLayoutEffect(() => {
    const node = world.current;
    if (!node) return;
    const measure = () => {
      const next = measureTargets(node, present, applied.current);
      setBoxes((current) => (sameBoxes(current, next) ? current : next));
      setMeasured(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const id of present) node.querySelectorAll(`[data-canvas-element-id="${CSS.escape(id)}"]`).forEach((element) => observer.observe(element));
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- present and the elements are covered by elementsKey
  }, [elementsKey]);

  const placeable = !pins.finished && !pins.view.showBefore;
  const capturing = placeable && (alt || pins.picking);
  const placed = [...pins.mine, ...pins.theirs].filter((pin) => !pins.deleting[pin.id]);
  const draft = pins.editor?.draft;
  const zones = [
    ...placed.flatMap((pin) => (pin.target.kind === "zone" && pin.target.space === "canvas" ? [{ id: pin.id, pin, target: pin.target }] : [])),
    ...(draft?.target.kind === "zone" && draft.target.space === "canvas" ? [{ id: "draft", pin: undefined as ReviewPin | undefined, target: draft.target }] : []),
  ];
  const elementPins = [
    ...placed.flatMap((pin) => (pin.target.kind === "canvas-element" && boxes.get(pin.target.elementId) ? [{ id: pin.id, pin, elementId: pin.target.elementId }] : [])),
    ...(draft?.target.kind === "canvas-element" && boxes.get(draft.target.elementId) ? [{ id: "draft", pin: undefined as ReviewPin | undefined, elementId: draft.target.elementId }] : []),
  ];
  const spots = elementPins.map((entry) => {
    const box = boxOnScreen(boxes.get(entry.elementId)!);
    return { ...entry, x: box.x + box.width - 14, y: box.y + 14 };
  });
  const offsets = pinOffsets(spots.map((spot) => ({ id: spot.id, xPct: spot.x, yPct: spot.y })));
  const zoneSpot = (zone: Extract<ReviewZoneTarget, { space: "canvas" }>) => ({ ...boxOnScreen({ x: zone.x, y: zone.y, width: zone.w, height: zone.h }) });

  const editingId = pins.editor ? (pins.editor.pinId ?? "draft") : undefined;
  const editingSpot = editingId === undefined ? undefined : (() => {
    const pin = spots.find((spot) => spot.id === editingId);
    if (pin) return { at: { x: pin.x, y: pin.y }, pin: pin.pin, zone: false };
    const zone = zones.find((entry) => entry.id === editingId);
    if (!zone) return undefined;
    const rect = zoneSpot(zone.target);
    return { at: { x: rect.x + rect.width, y: rect.y + rect.height }, pin: zone.pin, zone: true };
  })();
  const pct = (at: Point) => ({ xPct: (at.x / size.width) * 100, yPct: (at.y / size.height) * 100 });
  const hoverEntry = (() => {
    if (hovered === undefined) return undefined;
    const spot = spots.find((entry) => entry.id === hovered && entry.pin && !entry.pin.mine);
    if (spot) return { pin: spot.pin!, at: { x: spot.x, y: spot.y } };
    const zone = zones.find((entry) => entry.id === hovered && entry.pin && !entry.pin.mine);
    return zone && { pin: zone.pin!, at: zoneSpot(zone.target) };
  })();

  const canvasPoint = (event: ReactPointerEvent): Point => {
    const rect = area.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / shownScale + shown.x, y: (event.clientY - rect.top) / shownScale + shown.y };
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    if (!capturing) {
      // A plain drag on the canvas itself (not on a pin) moves the shown piece.
      if (event.target !== event.currentTarget || panning.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      panning.current = { id: event.pointerId, at: { x: event.clientX, y: event.clientY } };
      setPanActive(true);
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { start: canvasPoint(event), altKey: event.altKey };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const pan = panning.current;
    if (pan) {
      if (event.pointerId !== pan.id) return;
      panning.current = { id: pan.id, at: { x: event.clientX, y: event.clientY } };
      panLatest.current(event.clientX - pan.at.x, event.clientY - pan.at.y);
      return;
    }
    const current = gesture.current;
    const point = canvasPoint(event);
    if (current?.altKey && !phone) setDrawing(canvasZoneFromDrag(current.start, point, shown, shownScale));
    else if (!current && capturing) setHovered(canvasElementAt(point, new Map([...boxes].filter(([id]) => present.includes(id)))) );
  };
  const stopPanning = () => {
    panning.current = undefined;
    setPanActive(false);
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    if (panning.current) return event.pointerId === panning.current.id ? stopPanning() : undefined;
    const current = gesture.current;
    gesture.current = undefined;
    setDrawing(undefined);
    if (!current) return;
    const end = canvasPoint(event);
    const zone = current.altKey && !phone ? canvasZoneFromDrag(current.start, end, shown, shownScale) : undefined;
    if (zone) return pins.placeZone(zone);
    // A click: the targeted element under it; on empty canvas (or on a dimmed artboard) nothing happens.
    const elementId = canvasElementAt(current.start, new Map([...boxes].filter(([id]) => present.includes(id))));
    const element = elementId === undefined ? undefined : canvas.elements.find((candidate) => candidate.id === elementId);
    if (element) pins.placeCanvas(element.id!, element.kind);
  };

  return (
    <>
    <div ref={area} className={cx(styles.canvasCrop, !measured && styles.canvasCropHidden)} style={{ width: size.width, height: size.height, ["--canvas-target-color" as string]: HOVER_FINISH.color }} data-testid="review-canvas">
      <div ref={world} className={styles.canvasWorld} style={{ transform: measured ? `scale(${shownScale}) translate(${-shown.x}px, ${-shown.y}px)` : "none" }}>
        {canvas.artboards.map((artboard) => {
          const box = artboardBoxes.get(artboard.file)!;
          const visible = box.x < shown.x + shown.width && box.x + box.width > shown.x && box.y < shown.y + shown.height && box.y + box.height > shown.y;
          if (!visible) return null;
          return (
            <div key={artboard.file} className={styles.canvasArtboard} style={{ left: box.x, top: box.y, width: box.width, height: box.height }} data-canvas-artboard={artboard.file}>
              <span className={styles.canvasArtboardTitle} style={{ fontSize: 12 / shownScale }}>
                {artboard.title ?? artboard.file}
              </span>
              <div className={styles.canvasArtboardFrame}>
                {!artboard.responsive && origin && (
                  <ArtboardIframe title={`Canevas / ${artboard.file}`} src={`${origin}/pages/${step.pageId}/${artboard.file}`} sandbox="allow-scripts" loading="lazy" tabIndex={-1} aria-hidden="true" style={{ width: artboard.width, height: artboard.height, border: 0, transformOrigin: "0 0" }} />
                )}
              </div>
            </div>
          );
        })}
        <CanvasElements elements={canvas.elements} artboardBoxes={artboardBoxes} assetBase={`${origin}/pages/${step.pageId}`} artboardOrigin={origin} picking={false} zoom={shownScale} threads={[]} marks={[]} liftTitles={false} />
      </div>
      <div className={styles.canvasLayer}>
        {markersShown &&
          present.flatMap((id, index) => {
            const box = boxes.get(id);
            if (!box) return [];
            const at = boxOnScreen(box);
            return [
              <div key={id} className={cx(styles.canvasTarget, hovered === id && capturing && styles.canvasTargetHover)} style={{ left: at.x, top: at.y, width: at.width, height: at.height }} data-canvas-target={targetIds.indexOf(id) + firstFrame}>
                <span className={styles.canvasTargetNumber} aria-hidden="true">
                  {targetIds.indexOf(id) + firstFrame}
                </span>
              </div>,
            ];
          })}
      </div>
      {allGone && (
        <div className={styles.canvasGone} data-testid="review-canvas-gone">
          <div>
            <strong>Cette note n'existe plus</strong>
            <span>Elle a été retirée du canevas depuis la demande de revue. Tu peux quand même répondre à la question.</span>
          </div>
        </div>
      )}
      <div className={cx(styles.canvasLayer, capturing ? styles.canvasCapturing : styles.canvasPannable, panActive && styles.canvasPanning)} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => ((gesture.current = undefined), setDrawing(undefined), stopPanning())} onPointerLeave={() => setHovered(undefined)}>
        {drawing?.space === "canvas" && <div className={styles.zone} style={zoneStyle(zoneSpot(drawing))} data-testid="review-zone-drawing" />}
        {zones.map((zone) => {
          const pin = zone.pin;
          const mine = pin?.mine ?? true;
          const number = pin?.number ?? pins.draftNumber;
          return (
            <div key={zone.id} className={cx(styles.zone, !mine && styles.zoneTheirs)} style={zoneStyle(zoneSpot(zone.target))} data-zone={number} data-zone-mine={mine}>
              <PinMarker number={number} id={zone.id} pin={pin} label={pinLabel(pin, "Zone")} className={styles.zonePin} finished={pins.finished} setHovered={setHovered} onEdit={pins.openEdit} tapReads={false} markId={false} />
            </div>
          );
        })}
        {spots.map((spot) => {
          const pin = spot.pin;
          return (
            <PinMarker
              key={spot.id}
              number={pin?.number ?? pins.draftNumber}
              id={spot.id}
              pin={pin}
              label={pinLabel(pin, "Épingle")}
              className={styles.canvasPin}
              style={{ left: spot.x - (offsets[spot.id] ?? 0) * PIN_SHIFT, top: spot.y }}
              finished={pins.finished}
              hovered={hovered}
              setHovered={setHovered}
              onEdit={pins.openEdit}
            />
          );
        })}
        {hoverEntry?.pin && <PinTooltip pin={hoverEntry.pin} style={overlayStyle("tooltip", pct(hoverEntry.at), size)} />}
        {editingSpot && pins.editor && !phone && (
          <PinPopoverAt
            style={overlayStyle("popover", pct(editingSpot.at), size)}
            editorKey={pins.editor.key}
            number={editingSpot.pin?.number ?? pins.draftNumber}
            zone={editingSpot.zone}
            label={editingSpot.pin ? pinTargetLabel(editingSpot.pin) : draft?.target.kind === "canvas-element" ? pinTargetLabel({ target: draft.target }) : "Zone"}
            saved={editingSpot.pin}
            pins={pins}
          />
        )}
      </div>
    </div>
    {measured && !allGone && (
    <ReviewZoomBar
      label="Zoom du canevas"
      testId="review-canvas-zoom"
      percent={view?.zoom ?? 1}
      canZoomOut={(view?.zoom ?? 1) > limits.min}
      canZoomIn={(view?.zoom ?? 1) < limits.max}
      onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
      onZoomIn={() => zoomBy(ZOOM_STEP)}
      raised={!phone && !pins.finished && stage.width < ZOOM_BAR_ROOM}
    >
      <button type="button" className={styles.canvasZoomReset} title="Revenir au cadrage de l'étape" onClick={() => setView(undefined)}>
        Recadrer
      </button>
    </ReviewZoomBar>
    )}
    </>
  );
}

const zoneStyle = (rect: { x: number; y: number; width: number; height: number }) => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
