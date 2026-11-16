import { stepIsCanvasOnly, type ChangeReviewStep } from "@redline/shared";

/** A mixed step (artboard and canvas elements) has a "Canevas" view while at least one of its elements is still on the page; with none left it behaves as an artboard step. */
export const hasCanvasView = (step: ChangeReviewStep): boolean => !stepIsCanvasOnly(step) && step.canvas !== undefined && (step.canvasElements ?? []).some((id) => !step.canvas!.missing.includes(id));

/** The canvas view comes first when every artboard of the step was deleted. */
export const opensOnCanvas = (step: ChangeReviewStep): boolean => hasCanvasView(step) && !step.artboardEntry && !(step.others ?? []).some((member) => member.artboardEntry);

/** The canvas of a mixed step seen as a canvas step: the controls and the stage then follow the canvas-only rules (no Avant, Tweaks or Habillage). */
export function canvasViewOf(step: ChangeReviewStep): ChangeReviewStep {
  return {
    ...step,
    id: `${step.id}#canvas`,
    artboard: "",
    artboardTitle: "Canevas",
    others: undefined,
    tweaks: undefined,
    targets: undefined,
    artboardEntry: undefined,
    artboardTweaks: undefined,
    savedTweaks: undefined,
    baselineVersionId: undefined,
    baselineAt: undefined,
    isNew: undefined,
    modifiedBy: undefined,
    modifiedAt: undefined,
  };
}

/** Claude's frames are numbered artboard targets first, then canvas elements: the number of the canvas view's first frame. */
export const firstCanvasFrame = (step: ChangeReviewStep): number => (stepIsCanvasOnly(step) ? 0 : (step.targets?.length ?? 0)) + 1;
