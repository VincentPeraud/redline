import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { canvasElementLabel, describeZone, renderingKey, stepIsCanvasOnly,type ManifestElementKind, type ArtboardRef, type ChangeReview, type ChangeReviewStep, type ReviewElementTarget, type ReviewPin, type ReviewPinTarget, type ReviewZoneTarget } from "@redline/shared";
import type { Pick } from "./ArtboardFrame.js";
import { cx } from "./ui/index.js";
import { useAltKey } from "./useAltKey.js";
import { personName } from "./ReviewRemark.js";
import { type DraftPin, type PinView, isArtboardElementTarget, phonePinText, pinHiddenWhy, pinIsShown, pinOffsets, pinTargetLabel, zoneFromDrag } from "./reviewPinRules.js";
import { PIN_HALF, PIN_SHIFT, PinMarker, PinTooltip, overlayStyle, pinLabel } from "./ReviewPinParts.js";
import { type StepControls } from "./useReviewControls.js";
import { titleOfArtboard } from "./reviewView.js";
import styles from "./ReviewScreen.module.css";

const SAVE_DELAY_MS = 600;
const UNDO_DELAY_MS = 5_000;
/** A pin whose element is not found must stay missing this long before it is reported lost: the artboard may still be drawing. */
const LOST_SETTLE_MS = 800;

export interface PinsApiProps {
  reviewPath: string;
  onReview: (review: ChangeReview) => void;
  onReload: () => void;
  onUnsaved: (unsaved: boolean) => void;
}

/** What the editor on the stage is working on: a pin being placed (no id yet) or a saved one. `key` keeps the panel mounted when the draft becomes a saved pin. */
export interface PinEditor {
  key: number;
  pinId?: string;
  draft?: DraftPin;
}

/** The pins of the step on screen: who is editing which, the pick mode, pending deletions and the calls to the server. */
export interface PinsController {
  finished: boolean;
  mine: ReviewPin[];
  theirs: ReviewPin[];
  view: PinView;
  editor: PinEditor | undefined;
  picking: boolean;
  setPicking: (picking: boolean) => void;
  deleting: Readonly<Record<string, true>>;
  /** The last save of the open pin failed. */
  failed: boolean;
  /** Bumped by "Réessayer" in the list: the open panel saves again. */
  retryNonce: number;
  retry: () => void;
  place: (pick: Pick) => void;
  placeCanvas: (elementId: string, elementKind: ManifestElementKind) => void;
  placeZone: (zone: ReviewZoneTarget) => void;
  openEdit: (pinId: string) => void;
  close: () => void;
  save: (text: string) => Promise<boolean>;
  requestDelete: (pinId: string) => void;
  undoDelete: (pinId: string) => void;
  setLost: (pinId: string, lost: boolean) => void;
  /** The number the pin being placed will most likely get. */
  draftNumber: number;
  /** Tells the review screen whether a pin text is waiting to be saved (it asks before the member leaves). */
  onUnsaved: (unsaved: boolean) => void;
}

async function send(api: PinsApiProps, method: "POST" | "PUT" | "DELETE", path: string, body?: unknown, keepalive = false): Promise<ChangeReview | "failed" | "no-content"> {
  const response = await fetch(`${api.reviewPath}${path}`, { method, keepalive, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }).catch(() => undefined);
  if (!response?.ok) {
    // A 409 means the review was finished meanwhile: show it as it is.
    if (response?.status === 409) api.onReload();
    return "failed";
  }
  return response.status === 204 ? "no-content" : ((await response.json()) as ChangeReview);
}

export function useReviewPins({ review, step, shown, controls, api }: { review: ChangeReview; step: ChangeReviewStep; shown: ChangeReviewStep; controls: StepControls; api: PinsApiProps }): PinsController {
  const finished = review.state !== "open";
  const [editor, setEditor] = useState<PinEditor | undefined>();
  const [picking, setPicking] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, true>>({});
  const [failed, setFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const keys = useRef(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const apiRef = useRef(api);
  apiRef.current = api;
  const view: PinView = { rendering: controls.rendering, values: controls.values, showBefore: controls.showBefore };
  const mine = step.pins.filter((pin) => pin.mine);
  const theirs = step.pins.filter((pin) => !pin.mine);

  // Switching view, rendering or state closes the panel (its text is saved on the way out); the pick mode ends with it.
  const viewKey = JSON.stringify([shown.pageId, shown.artboard, controls.showBefore, controls.rendering && renderingKey(controls.rendering), controls.values]);
  useEffect(() => {
    setEditor(undefined);
    setPicking(false);
  }, [viewKey]);
  useEffect(() => {
    if (finished) {
      setPicking(false);
      setEditor((current) => (current?.draft || current?.pinId ? current : undefined));
    }
  }, [finished]);
  useEffect(() => setFailed(false), [editor?.key]);

  // Leaving the step makes the pending deletions final.
  useEffect(
    () => () => {
      for (const [pinId, timer] of Object.entries(timers.current)) {
        clearTimeout(timer);
        void send(apiRef.current, "DELETE", `/pins/${pinId}`, undefined, true);
      }
    },
    [],
  );

  const startDraft = useCallback(
    (target: ReviewPinTarget) => {
      if (finished || controls.showBefore) return;
      // The canvas view of a mixed step has no artboard: its pins sit on the page, not on an artboard of the group.
      const onExample = stepIsCanvasOnly(shown) || (shown.pageId === step.pageId && shown.artboard === step.artboard);
      const rendering = controls.rendering && shown.artboardEntry?.responsive ? { format: controls.rendering.format, width: controls.rendering.width } : undefined;
      const draft: DraftPin = {
        key: ++keys.current,
        target,
        ...(onExample ? {} : { on: { pageId: shown.pageId, artboard: shown.artboard } }),
        ...(rendering ? { rendering } : {}),
        ...(controls.tweaks.length > 0 ? { tweaks: controls.values } : {}),
      };
      setEditor({ key: draft.key, draft });
      setPicking(false);
    },
    [finished, controls.showBefore, controls.rendering, controls.tweaks.length, controls.values, shown, step.pageId, step.artboard],
  );

  const place = useCallback(
    (pick: Pick) => startDraft({ selector: pick.selector, xPct: pick.xPct, yPct: pick.yPct, ...(pick.elementName ? { elementName: pick.elementName } : {}), ...(pick.instanceState ? { instanceState: pick.instanceState } : {}) }),
    [startDraft],
  );

  const save = useCallback(
    async (text: string): Promise<boolean> => {
      const current = editor;
      if (!current) return false;
      const result = current.pinId ? await send(api, "PUT", `/pins/${current.pinId}`, { text }) : await send(api, "POST", `/steps/${step.id}/pins`, { text, ...current.draft! });
      if (result === "failed" || result === "no-content") {
        setFailed(true);
        return false;
      }
      setFailed(false);
      if (!current.pinId) {
        // The new pin is the author's highest number on the step.
        const created = result.steps.find((entry) => entry.id === step.id)?.pins.filter((pin) => pin.mine).sort((a, b) => b.number - a.number)[0];
        if (created) setEditor((now) => (now?.key === current.key ? { key: current.key, pinId: created.id } : now));
      }
      api.onReview(result);
      return true;
    },
    [api, editor, step.id],
  );

  const requestDelete = useCallback((pinId: string) => {
    setEditor((current) => (current?.pinId === pinId ? undefined : current));
    setDeleting((current) => ({ ...current, [pinId]: true }));
    timers.current[pinId] = setTimeout(() => {
      delete timers.current[pinId];
      void send(apiRef.current, "DELETE", `/pins/${pinId}`).then((result) => {
        if (result !== "failed" && result !== "no-content") apiRef.current.onReview(result);
        setDeleting((current) => {
          const { [pinId]: _gone, ...rest } = current;
          return rest;
        });
      });
    }, UNDO_DELAY_MS);
  }, []);

  const undoDelete = useCallback((pinId: string) => {
    clearTimeout(timers.current[pinId]);
    delete timers.current[pinId];
    setDeleting((current) => {
      const { [pinId]: _undone, ...rest } = current;
      return rest;
    });
  }, []);

  const lostSent = useRef(new Map<string, boolean>());
  const setLost = useCallback((pinId: string, lost: boolean) => {
    if (lostSent.current.get(pinId) === lost) return;
    lostSent.current.set(pinId, lost);
    void send(apiRef.current, "PUT", `/pins/${pinId}/lost`, { lost });
  }, []);

  return {
    finished,
    mine,
    theirs,
    view,
    editor,
    picking,
    setPicking,
    deleting,
    failed,
    retryNonce,
    retry: () => setRetryNonce((nonce) => nonce + 1),
    place,
    placeZone: startDraft,
    placeCanvas: (elementId, elementKind) => startDraft({ kind: "canvas-element", elementId, elementKind }),
    openEdit: (pinId) => setEditor({ key: ++keys.current, pinId }),
    close: () => setEditor(undefined),
    save,
    requestDelete,
    undoDelete,
    setLost,
    draftNumber: Math.max(0, ...step.pins.map((pin) => pin.number)) + 1,
    onUnsaved: api.onUnsaved,
  };
}

type Point = { x: number; y: number };

/** An artboard zone laid over the stage: its rectangle in percent of the artboard. */
const zoneStyle = (zone: Extract<ReviewZoneTarget, { space: "artboard" }>) => ({ left: `${zone.xPct}%`, top: `${zone.yPct}%`, width: `${zone.wPct}%`, height: `${zone.hPct}%` });

interface Reported {
  id: string;
  xPct: number;
  yPct: number;
  matched: boolean;
  elementLost?: boolean;
  hidden?: boolean;
}

/** The pin markers over the artboard, the panel of the pin being edited and the hover card of other members' pins. Lives inside the artboard viewport, which clips them to it. */
export function PinLayer({ frame, bridgeEpoch, size, example, shown, pins, phone }: { phone: boolean; frame: RefObject<HTMLIFrameElement>; bridgeEpoch: number; size: { width: number; height: number }; example: ChangeReviewStep; shown: ChangeReviewStep; pins: PinsController }) {
  const alt = useAltKey();
  const [positions, setPositions] = useState<Reported[]>([]);
  /** The rectangle being drawn with Alt + drag, in percent of the artboard. */
  const [drawing, setDrawing] = useState<ReviewZoneTarget | undefined>();
  const onPlaceRef = useRef(pins.place);
  onPlaceRef.current = pins.place;
  const onZoneRef = useRef(pins.placeZone);
  onZoneRef.current = pins.placeZone;
  const exampleRef: ArtboardRef = { pageId: example.pageId, artboard: example.artboard };
  const shownRef: ArtboardRef = { pageId: shown.pageId, artboard: shown.artboard };
  const onStage = [...pins.mine, ...pins.theirs].filter((pin) => !pins.deleting[pin.id] && pinIsShown(pin, exampleRef, shownRef, pins.view));
  const draft = pins.editor?.draft;
  const zones = [...onStage.flatMap((pin) => (pin.target.kind === "zone" ? [{ id: pin.id, pin, target: pin.target }] : [])), ...(draft?.target.kind === "zone" ? [{ id: "draft", pin: undefined, target: draft.target }] : [])];
  const elementPins = onStage.filter((pin): pin is ReviewPin & { target: ReviewElementTarget } => isArtboardElementTarget(pin.target));
  const draftElement = draft && isArtboardElementTarget(draft.target) ? draft.target : undefined;
  const placeable = !pins.finished && !pins.view.showBefore;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; positions?: Reported[]; from?: Point; to?: Point; doc?: { w: number; h: number } } & Partial<Pick>;
      if (data.type === "redline:pin-positions") setPositions(data.positions ?? []);
      else if (data.type === "redline:picked") onPlaceRef.current(data as Pick);
      else if (data.type === "redline:zone-drag" || data.type === "redline:zone") {
        const zone = zoneFromDrag(data.from!, data.to!, { width: data.doc!.w, height: data.doc!.h });
        if (data.type === "redline:zone") {
          setDrawing(undefined);
          if (zone) onZoneRef.current(zone);
        } else setDrawing(zone);
      } else if (data.type === "redline:zone-cancel") setDrawing(undefined);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame]);

  useEffect(() => {
    if (bridgeEpoch === 0) return;
    frame.current?.contentWindow?.postMessage({ type: "redline:set-mode", picking: pins.picking && placeable, selecting: false, alt: alt && placeable, zones: placeable, forwardWheel: false }, "*");
  }, [frame, bridgeEpoch, pins.picking, placeable, alt]);

  const pinsKey = JSON.stringify([elementPins.map((pin) => [pin.id, pin.target]), draftElement]);
  useEffect(() => {
    if (bridgeEpoch === 0) return;
    const sent = [...elementPins.map((pin) => ({ id: pin.id, ...pin.target })), ...(draftElement ? [{ id: "draft", ...draftElement }] : [])];
    frame.current?.contentWindow?.postMessage({ type: "redline:set-pins", pins: sent }, "*");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsKey, bridgeEpoch]);

  // Whether a pin's element is still found in the current artboard is told to the server (once settled), so that Claude hears of a lost element at fetch.
  const lostKey = JSON.stringify(elementPins.map((pin) => [pin.id, pin.lost === true, positions.find((entry) => entry.id === pin.id)?.matched, positions.find((entry) => entry.id === pin.id)?.elementLost]));
  useEffect(() => {
    if (pins.finished || positions.length === 0) return;
    const timer = setTimeout(() => {
      for (const pin of elementPins) {
        const reported = positions.find((entry) => entry.id === pin.id);
        if (!reported || reported.hidden) continue;
        const lost = !reported.matched || reported.elementLost === true;
        if (lost !== (pin.lost === true)) pins.setLost(pin.id, lost);
      }
    }, LOST_SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lostKey]);

  const placed = [...elementPins, ...(draftElement ? [{ id: "draft" }] : [])];
  const resolved = placed.flatMap((entry) => {
    const pin = elementPins.find((candidate) => candidate.id === entry.id);
    const stored = pin?.target ?? draftElement!;
    const reported = positions.find((position) => position.id === entry.id);
    if (reported?.hidden) return [];
    return [{ id: entry.id, pin, xPct: reported?.matched ? reported.xPct : stored.xPct, yPct: reported?.matched ? reported.yPct : stored.yPct, matched: reported?.matched === true, lost: reported !== undefined && (!reported.matched || reported.elementLost === true) }];
  });
  const offsets = pinOffsets(resolved);
  const [hovered, setHovered] = useState<string | undefined>();
  const editingZone = pins.editor && zones.find((zone) => zone.id === (pins.editor!.pinId ?? "draft"));
  const editing = pins.editor && (editingZone && editingZone.target.space === "artboard" ? { id: editingZone.id, pin: editingZone.pin, xPct: editingZone.target.xPct + editingZone.target.wPct, yPct: editingZone.target.yPct + editingZone.target.hPct } : resolved.find((entry) => entry.id === (pins.editor!.pinId ?? "draft")));
  // On a phone the text field lives in the sheet, which leaves a thin strip of artboard: bring the pin into it.
  const layer = useRef<HTMLDivElement>(null);
  const editingId = phone && pins.editor ? (pins.editor.pinId ?? "draft") : undefined;
  const editingMatched = editingId !== undefined && resolved.some((entry) => entry.id === editingId);
  useEffect(() => {
    if (editingId === undefined || !editingMatched) return;
    layer.current?.querySelector(`[data-pin-id="${editingId}"]`)?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [editingId, editingMatched]);
  const hoverZone = hovered === undefined ? undefined : zones.find((zone) => zone.id === hovered && zone.pin && !zone.pin.mine);
  const hover = hovered === undefined ? undefined : (resolved.find((entry) => entry.id === hovered && entry.pin && !entry.pin.mine) ?? (hoverZone && hoverZone.target.space === "artboard" ? { pin: hoverZone.pin, xPct: hoverZone.target.xPct, yPct: hoverZone.target.yPct } : undefined));
  // The pin straddles its element's top-right corner (as in the mock-up), pulled back inside the artboard when the corner touches an edge.
  const anchorStyle = (entry: { xPct: number; yPct: number; matched: boolean }, offset: number) =>
    entry.matched
      ? { right: `max(calc(${100 - entry.xPct}% + ${offset * PIN_SHIFT}px - ${PIN_HALF}px), 0px)`, top: `max(calc(${entry.yPct}% - ${PIN_HALF}px), 0px)` }
      : { left: `calc(${entry.xPct}% - ${offset * PIN_SHIFT}px)`, top: `${entry.yPct}%`, transform: "translate(-50%, -50%)" };

  return (
    <div ref={layer} className={styles.pinLayer} data-testid="review-pin-layer">
      {drawing && drawing.space === "artboard" && <div className={styles.zone} style={zoneStyle(drawing)} data-testid="review-zone-drawing" />}
      {zones.map((zone) => {
        if (zone.target.space !== "artboard") return null;
        const pin = zone.pin;
        const mine = pin?.mine ?? true;
        const number = pin?.number ?? pins.draftNumber;
        return (
          <div key={zone.id} className={cx(styles.zone, !mine && styles.zoneTheirs)} style={zoneStyle(zone.target)} data-zone={number} data-zone-mine={mine}>
            <PinMarker number={number} id={zone.id} pin={pin} label={pinLabel(pin, "Zone")} className={styles.zonePin} finished={pins.finished} setHovered={setHovered} onEdit={pins.openEdit} tapReads={false} markId={false} />
            {!pin && <span className={styles.zoneSize}>Zone</span>}
          </div>
        );
      })}
      {resolved.map((entry) => {
        const pin = entry.pin;
        const number = pin?.number ?? pins.draftNumber;
        const label = pinLabel(pin, "Épingle");
        return (
          <PinMarker
            key={entry.id}
            number={number}
            id={entry.id}
            pin={pin}
            label={entry.lost ? `${label}, élément introuvable` : label}
            className={entry.lost ? styles.pinLost : undefined}
            style={anchorStyle(entry, offsets[entry.id] ?? 0)}
            finished={pins.finished}
            hovered={hovered}
            setHovered={setHovered}
            onEdit={pins.openEdit}
          />
        );
      })}
      {hover?.pin && <PinTooltip pin={hover.pin} style={overlayStyle("tooltip", hover, size)} />}
      {editing && pins.editor && !phone && (
        <PinPopoverAt
          style={overlayStyle("popover", editing, size)}
          editorKey={pins.editor.key}
          number={editing.pin?.number ?? pins.draftNumber}
          zone={editingZone !== undefined}
          label={editing.pin ? pinTargetLabel(editing.pin) : draftElement ? (draftElement.elementName ?? draftElement.selector) : "Zone"}
          saved={editing.pin}
          pins={pins}
        />
      )}
    </div>
  );
}

/** `PinPopover` placed beside its pin. */
export function PinPopoverAt({ style, editorKey, ...popover }: { style: CSSProperties; editorKey: number } & Parameters<typeof PinPopover>[0]) {
  return (
    <div className={styles.pinPop} style={style}>
      <PinPopover key={editorKey} {...popover} />
    </div>
  );
}

/** The panel next to a pin: its text saved on its own while typing, "Effacer" (with "Annuler" in the list) and "Fermer". An empty pin disappears on close. */
export function PinPopover({ number, zone, label, saved, pins, phone = false }: { number: number; zone: boolean; label: string; saved: ReviewPin | undefined; pins: PinsController; phone?: boolean }) {
  const savedText = saved?.text;
  const [text, setText] = useState(savedText ?? "");
  const [copied, setCopied] = useState(false);
  const saving = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ text, savedText, save: pins.save, failed: pins.failed });
  latest.current = { text, savedText, save: pins.save, failed: pins.failed };
  const finished = pins.finished;
  const unsaved = !finished && text.trim() !== "" && text !== savedText;
  useEffect(() => field.current?.focus(), []);

  const saveNow = useCallback(async () => {
    if (saving.current) return false;
    saving.current = true;
    const ok = await latest.current.save(latest.current.text);
    saving.current = false;
    return ok;
  }, []);

  // Autosave: a pause in typing saves; a failure waits for "Réessayer" instead of looping.
  useEffect(() => {
    if (finished || !unsaved || pins.failed) return;
    const timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [finished, unsaved, pins.failed, text, saveNow]);

  const retryNonce = pins.retryNonce;
  useEffect(() => {
    if (retryNonce > 0) void saveNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Leaving the panel (another view, another step) saves what was typed.
  useEffect(
    () => () => {
      const { text: typed, savedText: stored, failed } = latest.current;
      if (typed.trim() !== "" && typed !== stored && !failed && !saving.current) void latest.current.save(typed);
    },
    [],
  );

  const onUnsaved = pins.onUnsaved;
  useEffect(() => onUnsaved(unsaved), [unsaved, onUnsaved]);
  useEffect(() => () => onUnsaved(false), [onUnsaved]);

  const close = async () => {
    if (finished) return pins.close();
    if (unsaved) {
      if (!(await saveNow())) return;
    }
    if (saved && text.trim() === "") pins.requestDelete(saved.id);
    pins.close();
  };

  const status = finished
    ? unsaved
      ? "Non enregistré"
      : ""
    : pins.failed
      ? undefined
      : unsaved
        ? "Enregistrement"
        : saved && text.trim() !== ""
          ? "Enregistré"
          : "Vide : rien n'est gardé si tu fermes";

  if (phone) {
    return (
      <div role="group" aria-label={`Épingle ${number}`} className={styles.phonePin}>
        <span className={styles.phonePinHead}>
          <span className={cx(styles.pin, styles.pinStatic, styles.pinSmall)}>{number}</span>
          <span className={styles.popTarget}>Sur {label}</span>
        </span>
        <textarea ref={field} aria-label="Ton épingle" className={styles.textarea} readOnly={finished} value={text} placeholder="Ce qui ne va pas sur cet élément" onChange={(event) => setText(event.target.value)} />
        {pins.failed ? (
          <span className={styles.errorLine} role="alert">
            Pas enregistré : Redline ne répond pas.
            <button type="button" className={styles.linkButton} onClick={() => void saveNow()}>
              Réessayer
            </button>
          </span>
        ) : (
          <span className={styles.phonePinStatus}>{status}</span>
        )}
        <div className={styles.row}>
          {!finished && (
            <button type="button" className={styles.panelButton} disabled={text === "" && !saved} onClick={() => (saved ? pins.requestDelete(saved.id) : setText(""))}>
              Effacer
            </button>
          )}
          <button type="button" className={styles.panelButton} onClick={() => void close()}>
            Fermer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div role="dialog" aria-label={`${zone ? "Zone" : "Épingle"} ${number}`} className={styles.pop}>
      <div className={styles.popHead}>
        <span className={cx(styles.pin, styles.pinStatic)}>{number}</span>
        <span className={styles.popTarget}>{zone ? label : `Sur ${label}`}</span>
      </div>
      <textarea
        ref={field}
        aria-label={zone ? "Ta zone" : "Ton épingle"}
        className={styles.textarea}
        readOnly={finished}
        value={text}
        placeholder={zone ? "Ce qui ne va pas dans cette zone" : "Ce qui ne va pas sur cet élément"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && void close()}
      />
      <div className={styles.popFoot}>
        {pins.failed ? (
          <span className={styles.errorLine} role="alert">
            Pas enregistré : Redline ne répond pas.
            <button type="button" className={styles.linkButton} onClick={() => void saveNow()}>
              Réessayer
            </button>
          </span>
        ) : (
          <span>{status}</span>
        )}
        <span className={styles.authorSpacer} />
        {finished ? (
          unsaved && (
            <button type="button" className={cx(styles.panelButton, styles.smallButton)} onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
              {copied ? "Copié" : "Copier"}
            </button>
          )
        ) : (
          saved && (
            <button type="button" className={cx(styles.panelButton, styles.smallButton)} onClick={() => pins.requestDelete(saved.id)}>
              Effacer
            </button>
          )
        )}
        <button type="button" className={cx(styles.panelButton, styles.smallButton)} onClick={() => void close()}>
          Fermer
        </button>
      </div>
    </div>
  );
}

/** The reminder under the artboard: the shortcuts, or why pinning is off. */
export function PinHint({ pins, phone, sticky }: { pins: PinsController; phone: boolean; sticky: boolean }) {
  if (pins.finished || phone) return null;
  return (
    <div className={cx(styles.pinHint, sticky && styles.pinHintSticky)} data-testid="review-pin-hint">
      {pins.view.showBefore ? (
        <span>Vue Avant : repasse sur Après pour épingler</span>
      ) : pins.picking ? (
        <span>Clique sur l'élément à épingler</span>
      ) : (
        <>
          <span>
            <kbd>Alt</kbd> + clic : épingler un élément
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <kbd>Alt</kbd> + glisser : tracer une zone
          </span>
        </>
      )}
    </div>
  );
}

/** "Épingler": pins an element with a click, without the Alt key. Disabled on the "Avant" version. */
export function PinButton({ pins }: { pins: PinsController }) {
  const off = pins.view.showBefore;
  return (
    <button type="button" className={cx(styles.panelButton, styles.noGrow)} aria-pressed={pins.picking} disabled={off} title={off ? "Repasse sur Après pour épingler" : undefined} onClick={() => pins.setPicking(!pins.picking)}>
      {pins.picking ? "Annuler" : "Épingler"}
    </button>
  );
}

/** "Tes épingles et zones (n)": each of the member's pins with its target, text, "Modifier" and "Effacer" (with a short "Annuler"). */
export function PinsSection({ step, shown, pins, onShow }: { step: ChangeReviewStep; shown: ChangeReviewStep; pins: PinsController; onShow: (pin: ReviewPin) => void }) {
  const entries = pins.mine;
  if (entries.length === 0) return null;
  const example: ArtboardRef = { pageId: step.pageId, artboard: step.artboard };
  const shownRef: ArtboardRef = { pageId: shown.pageId, artboard: shown.artboard };
  const live = entries.filter((pin) => !pins.deleting[pin.id]).length;
  return (
    <section className={styles.section} data-testid="review-pins-list">
      <h3>Tes épingles et zones ({live})</h3>
      <div className={styles.pins}>
        {entries.map((pin) => {
          if (pins.deleting[pin.id]) {
            return (
              <div key={pin.id} className={styles.pi}>
                <span className={styles.pinBody}>
                  <span className={styles.author}>
                    {pin.target.kind === "zone" ? "Zone" : "Épingle"} {pin.number} effacée
                    <button type="button" className={cx(styles.linkButton, styles.hint)} onClick={() => pins.undoDelete(pin.id)}>
                      Annuler
                    </button>
                  </span>
                </span>
              </div>
            );
          }
          const hidden = pinHiddenWhy(pin, example, shownRef, pins.view);
          const editing = pins.editor?.pinId === pin.id;
          return (
            <div key={pin.id} className={cx(styles.pi, editing && styles.piCurrent)} data-pin-item={pin.number}>
              <span className={cx(styles.pin, styles.pinStatic, pin.lost && styles.pinLost)}>{pin.number}</span>
              <div className={styles.pinBody}>
                <span className={styles.piOn}>
                  {pinTargetLabel(pin)}
                  {hidden?.kind === "artboard" && <> sur {titleOfArtboard(step, hidden.on)}</>}
                  {hidden?.kind === "view" && <> sur {hidden.of === "canvas" ? "le canevas" : "l'artboard"}</>}
                  {hidden?.kind === "state" && <> · vu en {hidden.seenIn}</>}
                  {(hidden?.kind === "artboard" || hidden?.kind === "view" || hidden?.kind === "state") && (
                    <>
                      {" · "}
                      <button type="button" className={styles.linkButton} onClick={() => onShow(pin)}>
                        l'afficher
                      </button>
                    </>
                  )}
                </span>
                {hidden?.kind === "avant" && <span className={styles.piOn}>Masquée en vue Avant</span>}
                {pin.lost && <span className={styles.piWarn}>{pin.target.kind === "canvas-element" ? "Élément retiré du canevas : l'épingle n'a plus de place sur la page." : "Élément introuvable dans la nouvelle version : l'épingle reste à son ancienne place."}</span>}
                <span className={styles.piText}>{pin.text}</span>
                {editing && pins.failed && (
                  <span className={styles.errorLine} role="alert">
                    Pas enregistré : Redline ne répond pas.
                    <button type="button" className={styles.linkButton} onClick={pins.retry}>
                      Réessayer
                    </button>
                  </span>
                )}
                {!pins.finished && (
                  <div className={styles.piActs}>
                    <button type="button" className={cx(styles.panelButton, styles.smallButton)} onClick={() => pins.openEdit(pin.id)} disabled={hidden !== undefined}>
                      Modifier
                    </button>
                    <button type="button" className={cx(styles.panelButton, styles.smallButton)} onClick={() => pins.requestDelete(pin.id)}>
                      Effacer
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The text field of the pin being placed or edited, in the phone sheet (the artboard keeps a strip above it). */
export function PhonePinEditor({ pins }: { pins: PinsController }) {
  const editor = pins.editor;
  if (!editor) return null;
  const saved = editor.pinId ? pins.mine.find((pin) => pin.id === editor.pinId) : undefined;
  const target = saved?.target ?? editor.draft?.target;
  const zone = target?.kind === "zone";
  const label = saved ? pinTargetLabel(saved) : target && target.kind === "canvas-element" ? canvasElementLabel(target.elementKind) : target && isArtboardElementTarget(target) ? (target.elementName ?? target.selector) : "Zone";
  return <PinPopover key={editor.key} number={saved?.number ?? pins.draftNumber} zone={zone} label={label} saved={saved} pins={pins} phone />;
}

/** The bar of the pick mode on a phone, above the artboard. */
export function PhonePickBanner({ pins }: { pins: PinsController }) {
  return (
    <div className={styles.pickBanner} data-testid="review-pick-banner">
      <span>Touche un élément à épingler</span>
      <button type="button" className={styles.panelButton} onClick={() => pins.setPicking(false)}>
        Annuler
      </button>
    </div>
  );
}

/** "Épingler" in the row of the phone sheet. */
export function PhonePinButton({ pins }: { pins: PinsController }) {
  const off = pins.view.showBefore;
  return (
    <button type="button" className={styles.panelButton} disabled={off} title={off ? "Repasse sur Après pour épingler" : undefined} onClick={() => pins.setPicking(true)}>
      Épingler
    </button>
  );
}

/** The member's own pins and zones in the phone sheet: number, text and "Modifier" (the text field is in the sheet, so any pin can be edited). */
export function PhonePinsList({ pins }: { pins: PinsController }) {
  if (pins.mine.length === 0) return null;
  return (
    <div className={styles.phonePins} data-testid="review-pins-list">
      {pins.mine.map((pin) =>
        pins.deleting[pin.id] ? (
          <div key={pin.id} className={styles.phonePinItem}>
            <span className={styles.phonePinText}>{pin.target.kind === "zone" ? "Zone" : "Épingle"} {pin.number} effacée</span>
            <button type="button" className={styles.panelButton} onClick={() => pins.undoDelete(pin.id)}>
              Annuler
            </button>
          </div>
        ) : (
          <div key={pin.id} className={styles.phonePinItem} data-pin-item={pin.number}>
            <span className={cx(styles.pin, styles.pinStatic, pin.lost && styles.pinLost)}>{pin.number}</span>
            <span className={styles.phonePinText}>{phonePinText(pin)}</span>
            {!pins.finished && (
              <button type="button" className={styles.panelButton} onClick={() => pins.openEdit(pin.id)}>
                Modifier
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** Other members' pins on a phone: a line each, read by touching the numbered pin on the artboard (or in full when it is not on the stage). */
export function PhoneTheirPins({ pins, example, shown }: { pins: PinsController; example: ChangeReviewStep; shown: ChangeReviewStep }) {
  if (pins.theirs.length === 0) return null;
  const exampleRef: ArtboardRef = { pageId: example.pageId, artboard: example.artboard };
  const shownRef: ArtboardRef = { pageId: shown.pageId, artboard: shown.artboard };
  return (
    <div className={styles.phoneOthers}>
      {pins.theirs.map((pin) => (
        <p key={pin.id}>
          <strong>{personName(pin.person)}</strong>
          {pinIsShown(pin, exampleRef, shownRef, pins.view) ? ` ${pin.target.kind === "zone" ? "a tracé une zone" : `a épinglé ${pinTargetLabel(pin)}`} (${pin.number}) : touche l'épingle pour lire.` : ` · ${pinTargetLabel(pin)} (${pin.number}) : ${pin.text}`}
        </p>
      ))}
    </div>
  );
}

/** The other members' pins as rows of "Les autres", read-only. */
export function TheirPins({ pins }: { pins: PinsController }): ReactNode {
  return pins.theirs.map((pin) => (
    <div key={pin.id} className={styles.other}>
      <span className={cx(styles.pin, styles.pinStatic, styles.pinTheirs)}>{pin.number}</span>
      <span className={styles.otherText}>
        <strong>{personName(pin.person)}</strong> · {pinTargetLabel(pin)} : {pin.text}
      </span>
    </div>
  ));
}
