import { useCallback, useEffect, useState } from "react";
import { renderingKey, type ArtboardRendering } from "@redline/shared";

const STORAGE_KEY = "redline:play-rendering";
/** What is kept in `localStorage` when the viewer chose "Aucun" (a rendering is kept by its key). */
const STORED_NO_RENDERING = "none";
/** The `?rendu=` value that asks for "Aucun". */
const NO_RENDERING_PARAM = "aucun";

/** The `?rendu=` value that names a rendering. */
export const renderingParamOf = (rendering: ArtboardRendering | null) => (rendering ? renderingKey(rendering) : NO_RENDERING_PARAM);

/** What a `?rendu=` value asks for: a rendering key, a bare format (its first rendering), `aucun`, else the default (first) rendering. */
function renderingFromParam(renderings: ArtboardRendering[], renderingParam: string): ArtboardRendering | null {
  if (renderingParam === NO_RENDERING_PARAM) return null;
  return renderings.find((r) => renderingKey(r) === renderingParam) ?? renderings.find((r) => r.format === renderingParam) ?? renderings[0] ?? null;
}

/**
 * The format this viewer plays a responsive artboard in. The URL's `?rendu=` wins; without it the choice is remembered across reloads. `null` = "Aucun" (the whole window).
 * A remembered format the artboard does not declare falls back to its first one.
 */
export function usePlayRendering(renderings: ArtboardRendering[], renderingParam: string | undefined): [ArtboardRendering | null, (rendering: ArtboardRendering | null) => void] {
  const [stored, setStored] = useState(() => localStorage.getItem(STORAGE_KEY));
  useEffect(() => {
    if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
  }, [stored]);
  const select = useCallback((rendering: ArtboardRendering | null) => setStored(rendering ? renderingKey(rendering) : STORED_NO_RENDERING), []);
  if (renderingParam !== undefined) return [renderingFromParam(renderings, renderingParam), select];
  const selected = stored === STORED_NO_RENDERING ? null : (renderings.find((r) => renderingKey(r) === stored) ?? renderings[0] ?? null);
  return [selected, select];
}
