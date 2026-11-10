// The before / after view of a component (instances lot, ticket 15).
import type { ReviewChange, ReviewComponent } from "./diffusionReview.js";

/** A numbered dashed marker on an element of one side; `number` is the line number in the change list. */
export interface ComparisonMarker {
  number: number;
  selector: string;
}

/** One rendering of the component's artboard. */
export interface ComparisonSide {
  /** Path on the artboard origin. */
  url: string;
  width: number;
  height: number;
  markers: ComparisonMarker[];
}

/** `GET /api/design-systems/:id/components/:name/comparison`. */
export interface ComponentComparison {
  /** Without the `ui-` prefix. */
  name: string;
  kind: ReviewComponent["kind"];
  /** Number of the current diffusion, the "before" side. */
  diffusion: number;
  /** The component's lines of the review, in the same order (marker numbers are positions + 1). */
  changes: ReviewChange[];
  /** Absent for a new component. */
  diffused?: ComparisonSide;
  /** Absent for a removed component. */
  draft?: ComparisonSide;
}
