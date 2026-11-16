import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { stepIsGroup, versionPreviewPath, type ChangeReview, type ChangeReviewMember, type ChangeReviewStep } from "@redline/shared";
import { ArtboardIframe, useArtboardOrigin } from "./artboardCapability.js";
import { PlayFrame } from "./PlayFrame.js";
import { fitToStage, presentationOf, scrollTagLabel } from "./playFrames.js";
import { relativeTime } from "./relativeTime.js";
import { TweaksPanel } from "./TweaksPanel.js";
import { PinHint, PinLayer, type PinsController } from "./ReviewPins.js";
import { type StepControls } from "./useReviewControls.js";
import { cx } from "./ui/index.js";
import { formatWhen } from "./reviewView.js";
import styles from "./ReviewScreen.module.css";

/** What a device frame draws outside the viewport (a shadow ring), which the stage padding does not count. */
const DEVICE_BEZEL: Partial<Record<string, number>> = { phone: 10, tablet: 14 };
/** Space kept above Claude's first frame when the stage scrolls to it. */
const SCROLL_LEAD = 72;

/** The artboard of the step at full size, in the same frame and fit as Present, with the Tweaks panel over its right side. */
export function ReviewStage({
  review,
  step,
  example,
  modified,
  controls,
  openedMember,
  onOpenMember,
  pins,
  phone,
}: {
  pins: PinsController;
  phone: boolean;
  review: ChangeReview;
  /** What the stage shows: the step, or the artboard of its group that was opened. */
  step: ChangeReviewStep;
  example: ChangeReviewStep;
  modified: boolean;
  controls: StepControls;
  openedMember: number | undefined;
  onOpenMember: (member: number | undefined) => void;
}) {
  const origin = useArtboardOrigin(review.projectId);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const frame = useRef<HTMLIFrameElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && (event.data as { type?: string }).type === "redline:ready") setBridgeEpoch((epoch) => epoch + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (bridgeEpoch > 0) frame.current?.contentWindow?.postMessage({ type: "redline:set-tweaks", values: controls.values }, "*");
  }, [controls.values, bridgeEpoch]);
  // The elements Claude points at: framed and numbered in the declared order (the same on every artboard of a group, before and after).
  const targetsKey = JSON.stringify(example.targets ?? []);
  useEffect(() => {
    if (bridgeEpoch === 0) return;
    const markers = (JSON.parse(targetsKey) as string[]).map((selector, index) => ({ number: index + 1, selector }));
    frame.current?.contentWindow?.postMessage({ type: "redline:set-compare-markers", visible: controls.markersShown && markers.length > 0, markers }, "*");
  }, [targetsKey, controls.markersShown, bridgeEpoch]);
  const entry = step.artboardEntry;
  /** The stage's own padding keeps the artboard off its edges, so the fit takes the space inside it. */
  const shown = entry && presentationOf(entry, controls.framed, windowWidth, entry.responsive ? controls.rendering : undefined);
  const presentation = shown && { ...shown, stagePadding: DEVICE_BEZEL[shown.frame] ?? 0 };
  const fitted = presentation && fitToStage(presentation, size);
  const scale = fitted?.scale ?? 1;
  const scrolling = fitted?.scroll ?? null;
  // A tall artboard opens on Claude's first frame, once per step: switching Avant / Après reloads the iframe but keeps the scroll position.
  const openedOn = useRef<string>();
  const stepKey = `${review.id}/${step.id}/${step.pageId}/${step.artboard}`;
  const firstTarget = example.targets?.[0];
  useEffect(() => {
    if (bridgeEpoch === 0 || !scrolling || !firstTarget || openedOn.current === stepKey) return;
    const onLocated = (event: MessageEvent) => {
      const data = event.data as { type?: string; selector?: string; top?: number };
      if (event.source !== frame.current?.contentWindow || data.type !== "redline:located" || data.selector !== firstTarget) return;
      openedOn.current = stepKey;
      const area = stage.current;
      if (area) area.scrollTop = Math.max(0, (viewport.current?.offsetTop ?? 0) + (data.top ?? 0) * scale - SCROLL_LEAD);
    };
    window.addEventListener("message", onLocated);
    frame.current?.contentWindow?.postMessage({ type: "redline:locate", selector: firstTarget }, "*");
    return () => window.removeEventListener("message", onLocated);
  }, [bridgeEpoch, scrolling, firstTarget, stepKey, scale]);
  return (
    <main className={cx(styles.stage, stepIsGroup(example) && styles.stageGroup, scrolling && styles.stageScroll)}>
      {controls.showBefore && step.baselineAt && (
        <span data-testid="review-before-tag" className={styles.tag}>
          Avant · version du {formatWhen(step.baselineAt)}, avant la série
        </span>
      )}
      {modified && !controls.showBefore && (
        <span data-testid="review-modified-tag" className={styles.tag}>
          Nouvelle version{step.modifiedBy ? ` de ${step.modifiedBy}` : ""} depuis ta revue{step.modifiedAt ? ` · ${relativeTime(step.modifiedAt)}` : ""}
        </span>
      )}
      <div ref={stage} className={cx(styles.shotArea, scrolling && styles.shotAreaScroll)} tabIndex={scrolling ? 0 : undefined} aria-label={scrolling ? "Artboard, fais défiler pour tout voir" : undefined}>
        {scrolling && presentation && (
          <div className={cx(styles.sizeTag, (modified || (controls.showBefore && step.baselineAt)) && styles.sizeTagLow)} data-testid="review-scroll-tag">
            <span>{scrollTagLabel(scrolling, presentation.viewport)}</span>
          </div>
        )}
        {entry && presentation && fitted && origin ? (
          <div className={scrolling ? styles.tallWrap : styles.flatWrap}>
            <PlayFrame frame={presentation.frame} url={entry.url}>
              <div ref={viewport} className={styles.viewport} style={{ width: fitted.viewport.width * fitted.scale, height: fitted.viewport.height * fitted.scale }}>
                <ArtboardIframe
                  ref={frame}
                  title={`Revue / ${step.artboard}`}
                  src={controls.showBefore && step.baselineVersionId ? `${origin}${versionPreviewPath(step.pageId, step.baselineVersionId, step.artboard)}` : `${origin}/pages/${step.pageId}/${step.artboard}`}
                  sandbox="allow-scripts"
                  className={styles.frame}
                  style={{ width: fitted.viewport.width, height: fitted.viewport.height, transform: `scale(${fitted.scale})` }}
                />
                <PinLayer frame={frame} bridgeEpoch={bridgeEpoch} size={{ width: fitted.viewport.width * fitted.scale, height: fitted.viewport.height * fitted.scale }} example={example} shown={step} pins={pins} phone={phone} />
              </div>
            </PlayFrame>
          </div>
        ) : entry ? null : (
          <p className={styles.hint}>Cet artboard n'existe plus · {step.artboard}</p>
        )}
        <PinHint pins={pins} phone={phone} sticky={scrolling !== null} />
      </div>
      {stepIsGroup(example) && <GroupThumbnails example={example} origin={origin} openedMember={openedMember} onOpenMember={onOpenMember} />}
      {controls.tweaksOpen && controls.tweaks.length > 0 && (
        <aside aria-label="Tweaks" className={styles.tweaks}>
          <div className={styles.tweaksHead}>
            <strong>Tweaks</strong>
            <span>Ces réglages restent dans ta revue : rien n'est enregistré sur la page.</span>
          </div>
          <TweaksPanel theme="dark" tweaks={controls.tweaks} values={controls.values} onChange={controls.setValue} previews={entry && origin ? { pageId: step.pageId, artboardOrigin: origin, artboard: entry } : undefined} />
        </aside>
      )}
    </main>
  );
}

/** The thumbnails shown before "+ N autres" (two rows of four, the last cell being the "+ N autres" tile). */
const THUMBNAILS_SHOWN = 7;

/** The other artboards of a group as clickable thumbnails: a click shows one large, "Revenir à l'exemple" goes back. */
function GroupThumbnails({ example, origin, openedMember, onOpenMember }: { example: ChangeReviewStep; origin: string; openedMember: number | undefined; onOpenMember: (member: number | undefined) => void }) {
  const [all, setAll] = useState(false);
  const members = example.others!;
  const hidden = !all && members.length > THUMBNAILS_SHOWN + 1 ? members.length - THUMBNAILS_SHOWN : 0;
  const shown = members.map((member, index) => ({ member, index })).slice(0, hidden > 0 ? THUMBNAILS_SHOWN : members.length);
  const openedTitle = openedMember === undefined ? undefined : `${members[openedMember]!.pageTitle} · ${members[openedMember]!.artboardTitle}`;
  return (
    <section data-testid="review-others" className={styles.others}>
      <div className={styles.othersHead}>
        <h3>
          {openedTitle
            ? `Affiché : ${openedTitle}`
            : `Exemple : ${example.pageTitle} · ${example.artboardTitle}. Même changement sur ${members.length} autre${members.length > 1 ? "s" : ""} artboard${members.length > 1 ? "s" : ""} (un clic l'affiche en grand)`}
        </h3>
        {openedTitle && (
          <button type="button" className={cx(styles.panelButton, styles.backToExample)} onClick={() => onOpenMember(undefined)}>
            Revenir à l'exemple
          </button>
        )}
      </div>
      <div className={styles.grid}>
        {shown.map(({ member, index }) => (
          <button
            key={`${member.pageId}/${member.artboard}`}
            type="button"
            aria-pressed={index === openedMember}
            title={`${member.pageTitle} · ${member.artboardTitle}`}
            className={cx(styles.thumb, index === openedMember && styles.thumbOpened)}
            onClick={() => onOpenMember(index)}
          >
            <Thumbnail member={member} origin={origin} />
            <span>
              {member.pageTitle} · {member.artboardTitle}
            </span>
            {member.modified && <span className={cx(styles.chip, styles.chipChanged, styles.thumbChip)}>Modifié depuis ta revue</span>}
          </button>
        ))}
        {hidden > 0 && (
          <button type="button" className={styles.thumb} onClick={() => setAll(true)}>
            <span className={styles.thumbPreview} />
            <span>+ {hidden} autres</span>
          </button>
        )}
      </div>
    </section>
  );
}

/** A live, scaled and inert view of the artboard in a 16:9 box. */
function Thumbnail({ member, origin }: { member: ChangeReviewMember; origin: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const entry = member.artboardEntry;
  const size = entry && (entry.responsive?.[0] ?? entry);
  const scale = size && width > 0 ? Math.min(width / size.width, (width * 9) / 16 / size.height) : 0;
  return (
    <span ref={box} className={styles.thumbPreview}>
      {size && origin && scale > 0 && (
        <ArtboardIframe
          title={`Miniature / ${member.artboard}`}
          src={`${origin}/pages/${member.pageId}/${member.artboard}`}
          sandbox="allow-scripts"
          loading="lazy"
          tabIndex={-1}
          aria-hidden="true"
          className={styles.thumbFrame}
          style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
        />
      )}
    </span>
  );
}
