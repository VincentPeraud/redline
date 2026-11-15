import { useCallback, useState } from "react";
import { renderingKey, resolveDeclaredTweakValues, type ArtboardRendering, type ChangeReviewStep, type ManifestTweak, type TweakValue, type TweakValues } from "@redline/shared";
import { useStoredToggle } from "./useStoredToggle.js";

/** What the top bar, the stage and the side panel share for the step on screen. */
export interface StepControls {
  /** The renderings of a responsive artboard (empty for any other). */
  renderings: ArtboardRendering[];
  rendering: ArtboardRendering | undefined;
  chooseRendering: (rendering: ArtboardRendering) => void;
  /** The tweaks the Tweaks panel offers for this artboard. */
  tweaks: ManifestTweak[];
  /** Values the artboard shows: the page's saved values, then Claude's for the step, then the reviewer's own. */
  values: TweakValues;
  setValue: (id: string, value: TweakValue) => void;
  /** "Avant" is on: the stage shows the step's baseline version instead of the current one. */
  showBefore: boolean;
  chooseBefore: (before: boolean) => void;
  tweaksOpen: boolean;
  toggleTweaks: () => void;
}

/**
 * The reviewer's choices of rendering and tweak values, per step and kept on this screen only: nothing goes to the server, so a change made here
 * never becomes a version of the page (unlike a tweak changed in Present).
 */
export function useReviewControls(): (step: ChangeReviewStep) => StepControls {
  const [tweaksOpen, toggleTweaks] = useStoredToggle("redline:review-tweaks", false);
  const [ownValues, setOwnValues] = useState<Record<string, TweakValues>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [before, setBefore] = useState<Record<string, boolean>>({});
  const setValue = useCallback((stepId: string, id: string, value: TweakValue) => setOwnValues((current) => ({ ...current, [stepId]: { ...current[stepId], [id]: value } })), []);

  return (step) => {
    const renderings = step.artboardEntry?.responsive ?? [];
    const rendering = renderings.find((candidate) => renderingKey(candidate) === chosen[step.id]) ?? (step.mobile ? renderings.find((candidate) => candidate.format === "mobile") : undefined) ?? renderings[0];
    const tweaks = step.artboardTweaks ?? [];
    return {
      renderings,
      rendering,
      chooseRendering: (next) => setChosen((current) => ({ ...current, [step.id]: renderingKey(next) })),
      tweaks,
      values: resolveDeclaredTweakValues(tweaks, { ...step.savedTweaks, ...step.tweaks, ...ownValues[step.id] }),
      setValue: (id, value) => setValue(step.id, id, value),
      showBefore: Boolean(before[step.id] && step.baselineVersionId),
      chooseBefore: (next) => setBefore((current) => ({ ...current, [step.id]: next })),
      tweaksOpen,
      toggleTweaks,
    };
  };
}
