import { useEffect, useRef, useState } from "react";
import { RESPONSIVE_FORMATS, activeSteps, stepIsCanvasOnly, progressOf, renderingKey, renderingLabel, reviewPlace, stepIsMultiPage, stepLabel, type ArtboardRendering, type ChangeReview, type ChangeReviewStep } from "@redline/shared";
import { navigateTo, routeHref, type Route } from "./router.js";
import { type StepControls } from "./useReviewControls.js";
import { usePhone } from "./usePhone.js";
import { presentationOf } from "./playFrames.js";
import { cx } from "./ui/index.js";
import { personName } from "./ReviewRemark.js";
import { STEP_STATE, type View, neighbour, stepNumber, stepStateOf } from "./reviewView.js";
import styles from "./ReviewScreen.module.css";

/** "Desktop", or "Desktop · 1440" when the artboard has several renderings of the same format. */
const renderingOptionLabel = (renderings: ArtboardRendering[], rendering: ArtboardRendering) =>
  renderings.filter((other) => other.format === rendering.format).length > 1 ? renderingLabel(rendering) : RESPONSIVE_FORMATS[rendering.format].label;

export function ReviewTopBar({ review, view, shown, controls, onGo, onLeave, onFinish }: { review: ChangeReview; view: View; shown?: ChangeReviewStep; controls?: StepControls; onGo: (view: View) => void; onLeave: (action: () => void) => void; onFinish: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const phone = usePhone();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const total = activeSteps(review.steps).length;
  const previous = view === "recap" ? undefined : neighbour(review, view, -1);
  const next = view === "recap" ? undefined : neighbour(review, view, 1);
  const step = shown;
  const requester = review.requester.person;
  const place = reviewPlace(review.requester);
  const backTo: Route = view === "recap" || review.steps[view]!.removed ? { name: "project", projectId: review.projectId } : { name: "page", pageId: review.steps[view]!.pageId };
  // A group spanning several pages is listed apart, under "Sur plusieurs pages" (they come last in the review).
  const groups = review.steps.reduce<{ key: string; title: string; entries: { step: ChangeReviewStep; index: number }[] }[]>((acc, entryStep, index) => {
    if (entryStep.removed) return acc;
    const multi = stepIsMultiPage(entryStep);
    const key = multi ? "" : entryStep.pageId;
    const last = acc[acc.length - 1];
    if (last && last.key === key) last.entries.push({ step: entryStep, index });
    else acc.push({ key, title: multi ? "Sur plusieurs pages" : entryStep.pageTitle, entries: [{ step: entryStep, index }] });
    return acc;
  }, []);

  return (
    <header data-testid="review-top" className={styles.top}>
      <div className={styles.lead}>
        {phone ? (
          <button type="button" className={styles.button} aria-label="Retour au canvas" onClick={() => onLeave(() => navigateTo(backTo))}>
            ←
          </button>
        ) : (
          <>
            <button type="button" className={styles.button} onClick={() => onLeave(() => navigateTo(backTo))}>
              ← Canvas
            </button>
            <span className={styles.mode}>Revue</span>
            <span data-testid="review-title" className={styles.title}>
              Revue{requester ? <> de <strong>{personName(requester)}</strong></> : ""} · {place} · {review.projectTitle}
            </span>
          </>
        )}
      </div>
      <div ref={menu} className={styles.counterWrap}>
        {phone && <span className={styles.mode}>Revue</span>}
        {view !== "recap" && !phone && (
          <button type="button" className={styles.button} aria-label="Étape précédente" disabled={previous === undefined} onClick={() => onGo(previous!)}>
            ←
          </button>
        )}
        <button type="button" className={styles.counter} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          {view === "recap" ? "Récapitulatif" : `${phone ? "" : "Étape "}${stepNumber(review, view)} / ${total}`}
          {view === "recap" && review.state === "open" && <small className={styles.counterSmall}>· {progressOf(review.steps, -1).seen} / {total} vus</small>}
          <span className={styles.chev} aria-hidden="true">
            ▼
          </span>
        </button>
        {view !== "recap" && !phone && (
          <button type="button" className={styles.button} aria-label="Étape suivante" onClick={() => onGo(next ?? "recap")}>
            →
          </button>
        )}
        {menuOpen && (
          <div role="menu" aria-label="Étapes de la revue" className={styles.menu}>
            {groups.map((group) => (
              <div key={group.key || "multi"}>
                <h4>{group.title}</h4>
                {group.entries.map(({ step, index }) => (
                  <button
                    key={step.id}
                    type="button"
                    role="menuitem"
                    className={cx(styles.menuItem, index === view && styles.menuItemCurrent)}
                    onClick={() => {
                      setMenuOpen(false);
                      onGo(index);
                    }}
                  >
                    <span className={styles.menuNumber}>{stepNumber(review, index)}</span>
                    <span className={cx(styles.dot, STEP_STATE[stepStateOf(step)].dot, index === view && styles.dotCurrent)} />
                    <span className={styles.menuTitle}>{stepLabel(step)}</span>
                    <span className={styles.menuState}>{index === view ? "En cours" : STEP_STATE[stepStateOf(step)].label}</span>
                  </button>
                ))}
              </div>
            ))}
            {phone && review.state === "open" && (
              <button
                type="button"
                role="menuitem"
                className={cx(styles.menuItem, styles.menuFinish)}
                onClick={() => {
                  setMenuOpen(false);
                  onFinish();
                }}
              >
                Terminer la revue
              </button>
            )}
          </div>
        )}
      </div>
      <div className={styles.trail}>
        {phone && controls && step && !step.removed && (step.baselineVersionId || step.isNew || stepIsCanvasOnly(step)) && (
          <button type="button" aria-label="Avant ou après" aria-pressed={controls.showBefore} disabled={step.isNew || stepIsCanvasOnly(step)} className={cx(styles.button, controls.showBefore && styles.buttonOn)} onClick={() => controls.chooseBefore(!controls.showBefore)}>
            Avant
          </button>
        )}
        {!phone && controls && step && !step.removed && (step.baselineVersionId || step.isNew || stepIsCanvasOnly(step)) && (
          <div role="group" aria-label="Version" className={styles.seg}>
            <button
              type="button"
              aria-pressed={controls.showBefore}
              disabled={step.isNew || stepIsCanvasOnly(step)}
              title={stepIsCanvasOnly(step) ? "Le canevas n'a pas de version « avant » à comparer" : step.isNew ? "Nouveau, pas d'avant" : undefined}
              className={cx(styles.segButton, controls.showBefore && styles.segButtonOn)}
              onClick={() => controls.chooseBefore(true)}
            >
              Avant
            </button>
            <button type="button" aria-pressed={!controls.showBefore} className={cx(styles.segButton, !controls.showBefore && styles.segButtonOn)} onClick={() => controls.chooseBefore(false)}>
              Après{step.isNew ? " (nouveau)" : ""}
            </button>
          </div>
        )}
        {!phone && controls && controls.renderings.length > 0 && (
          <div role="group" aria-label="Rendu" className={styles.seg}>
            {controls.renderings.map((rendering) => (
              <button
                key={renderingKey(rendering)}
                type="button"
                aria-pressed={rendering === controls.rendering}
                className={cx(styles.segButton, rendering === controls.rendering && styles.segButtonOn)}
                onClick={() => controls.chooseRendering(rendering)}
              >
                {renderingOptionLabel(controls.renderings, rendering)}
              </button>
            ))}
          </div>
        )}
        {!phone && controls && step?.artboardEntry && presentationOf(step.artboardEntry, controls.framed, window.innerWidth, controls.rendering).framable && (
          <button
            type="button"
            aria-pressed={controls.framed}
            aria-label="Habillage"
            title={`Habillage : ${(controls.rendering ? controls.rendering.format === "desktop" : step.artboardEntry.frame === "browser") ? "afficher ou masquer la fenêtre de navigateur" : "afficher ou masquer le cadre de l'appareil"}`}
            className={cx(styles.button, styles.iconButton, controls.framed && styles.buttonOn)}
            onClick={controls.toggleFramed}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {(controls.rendering ? controls.rendering.format === "desktop" : step.artboardEntry.frame === "browser") ? (
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
          </button>
        )}
        {!phone && controls && (step?.targets || step?.canvasElements) && (
          <button
            type="button"
            aria-pressed={controls.markersShown}
            aria-label="Repères"
            title="Repères : afficher ou masquer les cadres des éléments à regarder"
            className={cx(styles.button, styles.iconButton, controls.markersShown && styles.buttonOn)}
            onClick={controls.toggleMarkers}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="6" width="16" height="12" rx="2" strokeDasharray="3 2.5" />
            </svg>
          </button>
        )}
        {!phone && controls && controls.tweaks.length > 0 && (
          <button
            type="button"
            aria-pressed={controls.tweaksOpen}
            aria-label="Tweaks"
            title="Tweaks : régler les états de l'artboard"
            className={cx(styles.button, styles.iconButton, controls.tweaksOpen && styles.buttonOn)}
            onClick={controls.toggleTweaks}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="10" cy="17" r="2" />
            </svg>
          </button>
        )}
        {!phone && controls && step && !step.removed && step.artboard !== "" && !stepIsCanvasOnly(step) && (
          <a
            href={routeHref({ name: "page", pageId: step.pageId, artboard: step.artboard })}
            target="_blank"
            rel="noopener"
            aria-label="Ouvrir l'artboard dans un nouvel onglet"
            title="Ouvrir l'artboard dans un nouvel onglet"
            className={cx(styles.button, styles.iconButton)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            </svg>
          </a>
        )}
        {!phone && review.state === "open" && view !== "recap" && (
          <button type="button" className={cx(styles.button, styles.buttonLight)} onClick={onFinish}>
            Terminer la revue
          </button>
        )}
      </div>
    </header>
  );
}
