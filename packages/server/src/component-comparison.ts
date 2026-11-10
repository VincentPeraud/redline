import { type ChangeRecord, type ComparisonMarker, type ComparisonSide, type ComponentComparison, type ComponentInfo } from "@redline/shared";
import { diffusionReview } from "./diffusion-review.js";
import type { Store } from "./store.js";

const DEFAULT_SIZE = { width: 800, height: 600 };

function sideOf(component: ComponentInfo, diffusion: number | undefined, markers: ComparisonMarker[]): ComparisonSide {
  const path = `/pages/${component.page.id}/${component.file}`;
  const { width, height } = component.size ?? DEFAULT_SIZE;
  return { url: diffusion === undefined ? path : `${path}?diffusion=${diffusion}`, width, height, markers };
}

/** Markers by side: an added zone shows on the draft, a removed one on the diffused version, a modified one on both. */
function markersOf(records: (ChangeRecord | undefined)[]): { draft: ComparisonMarker[]; diffused: ComparisonMarker[] } {
  const draft: ComparisonMarker[] = [];
  const diffused: ComparisonMarker[] = [];
  records.forEach((record, index) => {
    if (!record?.anchor) return;
    const number = index + 1;
    if (record.kind !== "removed" && record.anchor.draft) draft.push({ number, selector: record.anchor.draft });
    if (record.kind !== "added" && record.anchor.diffused) diffused.push({ number, selector: record.anchor.diffused });
  });
  return { draft, diffused };
}

/** The before / after of one changed component; undefined when the component has no pending change. */
export function componentComparison(store: Store, designSystemId: string, name: string): ComponentComparison | undefined {
  const card = diffusionReview(store, designSystemId).components.find((candidate) => candidate.name === name);
  if (!card) return undefined;
  const current = store.currentDiffusion(designSystemId)!.number;
  const recorded = new Map(store.listChanges(designSystemId).map((change) => [change.id, change]));
  const markers = markersOf(card.changes.map((change) => (change.changeId === undefined ? undefined : recorded.get(change.changeId))));
  const inDraft = store.designSystemDraft(designSystemId).assembly.components.find((candidate) => candidate.name === name);
  const inDiffusion = store.diffusionComponents(designSystemId, current).find((candidate) => candidate.name === name);
  return {
    name,
    kind: card.kind,
    diffusion: current,
    changes: card.changes,
    ...(inDiffusion && card.kind !== "added" && { diffused: sideOf(inDiffusion, current, markers.diffused) }),
    ...(inDraft && card.kind !== "removed" && { draft: sideOf(inDraft, undefined, markers.draft) }),
  };
}
