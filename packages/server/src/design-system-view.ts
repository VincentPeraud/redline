import type { ComponentDefinition, ComponentInfo } from "@redline/shared";
import type { Store } from "./store.js";

/** Which state of its design system a project uses: a numbered diffusion, or the draft as it stands after diffusion `afterDiffusion`. */
export type SeenState = { kind: "diffusion"; number: number } | { kind: "draft"; afterDiffusion: number };

/** The files of a design system in one state, with the same reads whichever state it is. */
export interface DesignSystemView {
  designSystemId: string;
  state: SeenState;
  /** The diffusion number itself, or the one the draft comes after. */
  diffusion: number;
  tokensCss(): string;
  componentsCss(): string;
  designMd(): string;
  components(): ComponentInfo[];
  componentFiles(): Record<string, string>;
  definitions(): ComponentDefinition[];
  /** The per-page component index text, by page id. */
  pageIndexes(): Record<string, string>;
}

/** A design system in a given state (the design system's own side, previews and tests); projects go through `designSystemSeenBy`. */
export function designSystemInState(store: Store, designSystemId: string, state: SeenState): DesignSystemView {
  if (state.kind === "diffusion") {
    const { number } = state;
    return {
      designSystemId,
      state,
      diffusion: number,
      tokensCss: () => store.readDiffusionFile(designSystemId, number, "tokens.css") ?? "",
      componentsCss: () => store.readDiffusionFile(designSystemId, number, "components.css") ?? "",
      designMd: () => store.readDiffusionFile(designSystemId, number, "DESIGN.md") ?? "",
      components: () => store.diffusionComponents(designSystemId, number),
      componentFiles: () => store.diffusionComponentFiles(designSystemId, number),
      definitions: () => store.diffusionDefinitions(designSystemId, number),
      pageIndexes: () => store.diffusionPageIndexes(designSystemId, number),
    };
  }
  const draft = () => store.designSystemDraft(designSystemId);
  return {
    designSystemId,
    state,
    diffusion: state.afterDiffusion,
    tokensCss: () => draft().state.tokensCss,
    componentsCss: () => draft().componentsCss,
    designMd: () => draft().state.designMd,
    components: () => draft().assembly.components,
    componentFiles: () => draft().componentFiles,
    definitions: () => draft().assembly.definitions,
    pageIndexes: () => draft().assembly.indexes,
  };
}

/**
 * What `projectId` sees of a design system (its shared one, or `designSystemId` when a page names another): the single place that
 * decides which state a project reads. Undefined when the project has no shared design system.
 */
export function designSystemSeenBy(store: Store, projectId: string, designSystemId: string | undefined = store.sharedDesignSystemIdOfProject(projectId)): DesignSystemView | undefined {
  if (designSystemId === undefined) return undefined;
  const current = currentDiffusionOf(store, designSystemId);
  // The setting is about the project's own shared design system: a page that names another one sees that one's diffusion.
  if (current && designSystemId === store.sharedDesignSystemIdOfProject(projectId) && store.projectFollowsDraft(projectId)) {
    return designSystemInState(store, designSystemId, { kind: "draft", afterDiffusion: current.diffusion });
  }
  return current;
}

/** The current diffusion of a design system, for what is not about a project's own setting (the target of a switch, a diffusion's follow-up). */
export function currentDiffusionOf(store: Store, designSystemId: string): DesignSystemView | undefined {
  const current = store.currentDiffusion(designSystemId);
  return current ? designSystemInState(store, designSystemId, { kind: "diffusion", number: current.number }) : undefined;
}

/** The draft of a design system as it stands after its current diffusion, whatever any project follows (the design system's own side, what a restore or a switch of the setting compares). */
export function draftOf(store: Store, designSystemId: string): DesignSystemView | undefined {
  const current = currentDiffusionOf(store, designSystemId);
  return current && designSystemInState(store, designSystemId, { kind: "draft", afterDiffusion: current.diffusion });
}
