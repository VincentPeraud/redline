import { useState } from "react";
import { activeSteps, progressOf, renderingKey, stepIsCanvasOnly, stepIsGroup, stepIsModified, stepLabel, stepStatus, type ChangeReview, type ChangeReviewStep, type ReviewPin, type TweakValues } from "@redline/shared";
import { type StepControls } from "./useReviewControls.js";
import { usePhone } from "./usePhone.js";
import { cx } from "./ui/index.js";
import { counted } from "./plural.js";
import { PersonDot, RemarkEditor, personName } from "./ReviewRemark.js";
import { PhonePickBanner, PhonePinButton, PhonePinEditor, PhonePinsList, PhoneTheirPins, PinButton, PinsSection, TheirPins, useReviewPins } from "./ReviewPins.js";
import { feedbackReplacesOk } from "./reviewPinRules.js";
import { STEP_STATE, type View, formatWhen, lockTitle, lockWhen, neighbour, reviewPath, shownStep, stepNumber, titleOfArtboard } from "./reviewView.js";
import { ReviewStage } from "./ReviewStage.js";
import styles from "./ReviewScreen.module.css";

function Progress({ review, index }: { review: ChangeReview; index: number }) {
  const { seen, total, segments } = progressOf(review.steps, index);
  return (
    <div data-testid="review-progress" className={styles.progress} aria-label="Progression de la revue">
      <div className={styles.progressHead}>
        <span>Progression</span>
        <strong>
          {seen} / {total} vus
        </strong>
      </div>
      <div className={styles.progressBar}>
        {segments.map((segment, position) => (
          <i key={activeSteps(review.steps)[position]!.id} className={cx(styles.segment, segment === "ok" && styles.segmentOk, segment === "remark" && styles.segmentRemark, segment === "current" && styles.segmentCurrent, segment === "modified" && styles.segmentChanged)} />
        ))}
      </div>
    </div>
  );
}

type RemarkProps = { reviewPath: string; onReview: (review: ChangeReview) => void; onReload: () => void; onUnsaved: (unsaved: boolean) => void; onPinUnsaved: (unsaved: boolean) => void };

export function StepView({
  review,
  index,
  controls,
  openedMember,
  onOpenMember,
  failed,
  onGo,
  onOk,
  onClearAndValidate,
  onCancel,
  onReopen,
  remark,
}: {
  review: ChangeReview;
  index: number;
  controls: StepControls;
  openedMember: number | undefined;
  onOpenMember: (member: number | undefined) => void;
  failed: boolean;
  onGo: (view: View) => void;
  onOk: () => void;
  onClearAndValidate: () => void;
  onCancel: () => void;
  onReopen: () => void;
  remark: RemarkProps;
}) {
  const step = review.steps[index]!;
  const own = step.answers.find((answer) => answer.mine);
  const others = step.answers.filter((answer) => !answer.mine);
  const status = stepStatus(step.answers, step.pins);
  const finished = review.state !== "open";
  const [keptUnsaved, setKeptUnsaved] = useState(false);
  const phone = usePhone();
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The member's own answer saw an older version of the artboard.
  const group = stepIsGroup(step);
  const shown = shownStep(step, openedMember);
  const { onPinUnsaved, ...remarkProps } = remark;
  const pins = useReviewPins({ review, step, shown, controls, api: { reviewPath: remark.reviewPath, onReview: remark.onReview, onReload: remark.onReload, onUnsaved: onPinUnsaved } });
  const ownRemark = own?.kind === "remark";
  const hasFeedback = ownRemark || pins.mine.length > 0;
  const feedbackOutdated = (ownRemark && own.outdated === true) || pins.mine.some((pin) => pin.outdated);
  const modified = stepIsModified(step) || own?.outdated === true || feedbackOutdated;
  /** "l'afficher": brings the artboard, rendering and state a pin was placed in back on the stage. */
  const showPin = (pin: ReviewPin) => {
    controls.chooseBefore(false);
    const home = pin.on ? step.others?.findIndex((member) => member.pageId === pin.on!.pageId && member.artboard === pin.on!.artboard) : undefined;
    onOpenMember(home === undefined || home < 0 ? undefined : home);
    const rendering = pin.rendering && controls.renderings.find((candidate) => renderingKey(candidate) === renderingKey(pin.rendering!));
    if (rendering) controls.chooseRendering(rendering);
    for (const [id, value] of Object.entries(pin.tweaks ?? {})) controls.setValue(id, value);
  };
  const pinButton = !finished && <PinButton pins={pins} />;
  const size = group ? step.others!.length + 1 : 1;
  const pageCount = new Set([step.pageId, ...(step.others ?? []).map((member) => member.pageId)]).size;
  const changedNames = (step.others ?? []).filter((member) => member.modified).map((member) => `${member.pageTitle} · ${member.artboardTitle}`);
  const exampleChanged = step.modifiedAt !== undefined ? [`${step.pageTitle} · ${step.artboardTitle}`] : [];
  const changedSince = [...exampleChanged, ...changedNames];
  const chipText = finished ? "Lecture seule" : modified ? "Modifié depuis ta revue" : status === "ok" ? "✓ OK" : STEP_STATE[status].label;
  const chipClass = cx(styles.chip, !finished && !modified && status === "ok" && styles.chipOk, !finished && !modified && status === "remark" && styles.chipRemark, !finished && modified && styles.chipChanged);
  const remarkEditor = (
    <RemarkEditor
      stepId={step.id}
      own={own}
      finished={finished}
      onKeptUnsaved={setKeptUnsaved}
      placeholder={stepIsCanvasOnly(step) ? "Ce qui ne va pas sur cette partie de la page" : undefined}
      placement={group ? { shown: { pageId: shown.pageId, artboard: shown.artboard }, example: { pageId: step.pageId, artboard: step.artboard }, titleOf: (ref) => titleOfArtboard(step, ref) } : undefined}
      phone={phone ? { open: remarkOpen, onClose: () => setRemarkOpen(false) } : undefined}
      {...remarkProps}
    />
  );
  const groupWarning = group && !finished && own?.outdated && own.kind === "ok" && changedSince.length > 0 && (
    <span className={styles.hint}>
      Ton OK du {formatWhen(own.at)} ne compte plus : {changedSince.map((name) => `« ${name} »`).join(", ")} {changedSince.length > 1 ? "ont" : "a"} changé depuis.
    </span>
  );
  const failedLine = failed && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>;
  // On a phone the other members' pins are read on the artboard (a line each in the sheet), not listed in the details.
  const othersSection = others.length + (phone ? 0 : pins.theirs.length) > 0 && (
    <section className={styles.section}>
      <h3>Les autres</h3>
      {others.map((answer) => (
        <div key={answer.id} className={styles.other}>
          <PersonDot person={answer.person} />
          <span className={styles.otherText}>
            <strong>{personName(answer.person)}</strong> · {answer.kind === "ok" ? (answer.outdated ? "Validé (ancienne version)" : "✓ Validé") : answer.text}
          </span>
        </div>
      ))}
      {!phone && <TheirPins pins={pins} />}
    </section>
  );
  const lockBox = finished && (
    <div className={styles.lock}>
      <span>
        <strong>{lockTitle(review)}</strong>
        {lockWhen(review)} : plus de OK ni de remarque.{keptUnsaved ? " Ton texte non enregistré est gardé ci-dessous pour que tu le copies." : ""}
      </span>
      {review.state === "finished" && (
        <button type="button" className={styles.panelButton} onClick={onReopen}>
          Rouvrir la revue
        </button>
      )}
    </div>
  );
  const stateShownHint = step.tweaks && Object.keys(step.tweaks).length > 0 && <p className={styles.hint}>État affiché : « {stateShown(step, controls.tweaks)} », fixé par Claude. Les autres états restent dans Tweaks.</p>;
  const lookAt = (
    <>
      {step.mobile && (
        <>
          <strong>À regarder en mobile</strong> :{" "}
        </>
      )}
      {step.lookAt}
    </>
  );
  const next = neighbour(review, index, 1);

  if (phone) {
    const pinEditing = pins.editor !== undefined;
    const picking = pins.picking && !finished;
    const listing = !pinEditing && !picking;
    return (
      <div className={cx(styles.body, styles.bodyPhone, remarkOpen && !finished && styles.bodyRemarking, pinEditing && styles.bodyPinning, picking && styles.bodyPicking)}>
        {picking && <PhonePickBanner pins={pins} />}
        <ReviewStage review={review} step={shown} example={step} modified={modified && (!group || shown.modifiedAt !== undefined)} controls={controls} openedMember={openedMember} onOpenMember={onOpenMember} pins={pins} phone={phone} />
        <section aria-label="Question de l'étape" className={styles.sheet}>
          <span className={styles.grip} aria-hidden="true" />
          {pinEditing && !remarkOpen && <PhonePinEditor pins={pins} />}
          {picking && <p className={styles.sheetHint}>Les zones se tracent sur ordinateur.</p>}
          {listing && (
            <>
              <Progress review={review} index={index} />
              <div className={styles.sheetKicker}>
                <span className={styles.sheetName}>{stepLabel(step)}</span>
                <span className={styles.chips}>
                  {group && <span className={styles.chip}>Groupé</span>}
                  <span className={chipClass}>{chipText}</span>
                </span>
              </div>
              <p className={styles.sheetQuestion}>{step.question}</p>
              <button type="button" className={styles.more} aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>
                Ce qui a changé et quoi regarder
              </button>
              {detailsOpen && (
                <div className={styles.sheetDetails}>
                  <section className={styles.section}>
                    <h3>Ce qui a changé</h3>
                    <p>{step.changed}</p>
                  </section>
                  <section className={styles.section}>
                    <h3>Quoi regarder</h3>
                    <p>{lookAt}</p>
                    {stateShownHint}
                  </section>
                  {othersSection}
                </div>
              )}
              {groupWarning}
              {failedLine}
              {lockBox}
            </>
          )}
          {remarkEditor}
          {listing && !finished && !remarkOpen && (
            <>
              <PhonePinsList pins={pins} />
              <PhoneTheirPins pins={pins} example={step} shown={shown} />
              <div className={styles.row}>
                <PhonePinButton pins={pins} />
                <button type="button" className={styles.panelButton} onClick={() => setRemarkOpen(true)}>
                  {ownRemark && !(own?.outdated || feedbackOutdated) ? "Ma remarque" : "Remarque"}
                </button>
              </div>
              <div className={styles.row}>
                {own?.outdated || feedbackOutdated ? (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={hasFeedback ? onClearAndValidate : onOk}>
                    {pins.mine.length > 0 ? "Effacer mes retours et valider" : ownRemark ? "Effacer ma remarque et valider" : group ? `Revoir et valider les ${size}` : "Revoir et valider"}
                  </button>
                ) : hasFeedback ? (
                  <button type="button" className={cx(styles.panelButton, styles.light)} onClick={() => onGo(next ?? "recap")}>
                    Étape suivante
                  </button>
                ) : own ? (
                  <>
                    <button type="button" className={styles.panelButton} onClick={onCancel}>
                      Validé · annuler
                    </button>
                    <button type="button" className={cx(styles.panelButton, styles.light)} onClick={() => onGo(next ?? "recap")}>
                      Étape suivante
                    </button>
                  </>
                ) : (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onOk}>
                    {group ? `OK pour les ${size}` : "OK"}
                  </button>
                )}
              </div>
            </>
          )}
          {listing && finished && <PhonePinsList pins={pins} />}
        </section>
      </div>
    );
  }

  return (
    <div className={styles.body}>
      <ReviewStage review={review} step={shown} example={step} modified={modified && (!group || shown.modifiedAt !== undefined)} controls={controls} openedMember={openedMember} onOpenMember={onOpenMember} pins={pins} phone={phone} />
      <aside aria-label="Question de l'étape" className={styles.panel}>
        <div className={styles.panelScroll}>
          <Progress review={review} index={index} />
          <div>
            <div className={cx(styles.kicker, group && styles.kickerGroup)}>
              <span>
                {group ? `${counted(pageCount, "page", "pages")} · ${size} artboards` : stepIsCanvasOnly(step) ? `Page ${step.pageTitle} · canevas` : `Page ${step.pageTitle} · étape ${stepNumber(review, index)} / ${activeSteps(review.steps).length}`}
              </span>
              <span className={styles.chips}>
                {group && <span className={styles.chip}>Groupé</span>}
                <span className={chipClass}>{chipText}</span>
              </span>
            </div>
            <h2 className={styles.heading}>{stepLabel(step)}</h2>
          </div>
          <section className={styles.section}>
            <h3>Ce qui a changé</h3>
            <p>{step.changed}</p>
          </section>
          <section className={styles.section}>
            <h3>Quoi regarder</h3>
            <p>
              {step.mobile && (
                <>
                  <strong>À regarder en mobile</strong> :{" "}
                </>
              )}
              {step.lookAt}
            </p>
            {step.tweaks && Object.keys(step.tweaks).length > 0 && <p className={styles.hint}>État affiché : « {stateShown(step, controls.tweaks)} », fixé par Claude. Les autres états restent dans Tweaks.</p>}
          </section>
          <div className={styles.question}>
            <p>{step.question}</p>
            {!finished && (
              <div className={styles.row}>
                {hasFeedback && feedbackOutdated ? (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onClearAndValidate}>
                    {pins.mine.length > 0 ? "Effacer mes retours et valider" : "Effacer ma remarque et valider"}
                  </button>
                ) : hasFeedback ? (
                  <>
                    {pinButton}
                    <span className={cx(styles.hint, styles.rowHint)}>{pins.view.showBefore ? "Repasse sur Après pour épingler." : feedbackReplacesOk(pins.mine.filter((pin) => pin.target.kind !== "zone").length, ownRemark, pins.mine.filter((pin) => pin.target.kind === "zone").length)}</span>
                  </>
                ) : own?.outdated ? (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onOk}>
                    {group ? `Revoir et valider les ${size}` : "Revoir et valider"}
                  </button>
                ) : own ? (
                  <button type="button" className={styles.panelButton} onClick={onCancel}>
                    ✓ Validé par toi · annuler
                  </button>
                ) : (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onOk}>
                    {group ? `OK pour les ${size}` : "OK, étape suivante"}
                  </button>
                )}
                {(!hasFeedback || feedbackOutdated) && pinButton}
              </div>
            )}
            {group && !finished && own?.outdated && own.kind === "ok" && changedSince.length > 0 && (
              <span className={styles.hint}>
                Ton OK du {formatWhen(own.at)} ne compte plus : {changedSince.map((name) => `« ${name} »`).join(", ")} {changedSince.length > 1 ? "ont" : "a"} changé depuis.
              </span>
            )}
            {failed && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>}
          </div>
          <PinsSection step={step} shown={shown} pins={pins} onShow={showPin} />
          {othersSection}
          {finished && (
            <div className={styles.lock}>
              <span>
                <strong>{lockTitle(review)}</strong>
                {lockWhen(review)} : plus de OK ni de remarque.{keptUnsaved ? " Ton texte non enregistré est gardé ci-dessous pour que tu le copies." : ""}
              </span>
              {review.state === "finished" && (
                <button type="button" className={styles.panelButton} onClick={onReopen}>
                  Rouvrir la revue
                </button>
              )}
            </div>
          )}
          <RemarkEditor placeholder={stepIsCanvasOnly(step) ? "Ce qui ne va pas sur cette partie de la page" : undefined} stepId={step.id} own={own} finished={finished} onKeptUnsaved={setKeptUnsaved} placement={group ? { shown: { pageId: shown.pageId, artboard: shown.artboard }, example: { pageId: step.pageId, artboard: step.artboard }, titleOf: (ref) => titleOfArtboard(step, ref) } : undefined} {...remarkProps} />
        </div>
        <div className={styles.panelFoot}>
          <button type="button" className={styles.panelButton} disabled={neighbour(review, index, -1) === undefined} onClick={() => onGo(neighbour(review, index, -1)!)}>
            ← Précédente
          </button>
          <button type="button" className={styles.panelButton} onClick={() => onGo(neighbour(review, index, 1) ?? "recap")}>
            Suivante →
          </button>
        </div>
      </aside>
    </div>
  );
}

/** The values Claude set for the step, named by their tweak labels: "État : sommaire, Dense : oui". */
function stateShown(step: ChangeReviewStep, tweaks: StepControls["tweaks"]): string {
  const shown = (value: TweakValues[string]) => (typeof value === "boolean" ? (value ? "oui" : "non") : String(value));
  return Object.entries(step.tweaks ?? {})
    .map(([id, value]) => `${tweaks.find((tweak) => tweak.id === id)?.label ?? id} : ${shown(value)}`)
    .join(", ");
}
