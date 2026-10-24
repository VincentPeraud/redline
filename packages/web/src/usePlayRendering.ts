import { useCallback, useEffect, useState } from "react";
import { renderingKey, type ArtboardRendering } from "@redline/shared";

const STORAGE_KEY = "redline:play-rendering";
const NONE = "none";
const NONE_RENDU = "aucun";

/** The `rendu` value that names a rendering. */
export const renduOf = (rendering: ArtboardRendering | null) => (rendering ? renderingKey(rendering) : NONE_RENDU);

/** What a `rendu` URL value asks for: a rendering key, a bare format (its first rendering), `aucun`, else the default (first) rendering. */
function renderingFromRendu(renderings: ArtboardRendering[], rendu: string): ArtboardRendering | null {
  if (rendu === NONE_RENDU) return null;
  return renderings.find((r) => renderingKey(r) === rendu) ?? renderings.find((r) => r.format === rendu) ?? renderings[0] ?? null;
}

/**
 * The format this viewer plays a responsive artboard in. The URL's `rendu` wins; without it the choice is remembered across reloads. `null` = "Aucun" (the whole window).
 * A remembered format the artboard does not declare falls back to its first one.
 */
export function usePlayRendering(renderings: ArtboardRendering[], rendu: string | undefined): [ArtboardRendering | null, (rendering: ArtboardRendering | null) => void] {
  const [stored, setStored] = useState(() => localStorage.getItem(STORAGE_KEY));
  useEffect(() => {
    if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
  }, [stored]);
  const select = useCallback((rendering: ArtboardRendering | null) => setStored(rendering ? renderingKey(rendering) : NONE), []);
  if (rendu !== undefined) return [renderingFromRendu(renderings, rendu), select];
  const selected = stored === NONE ? null : (renderings.find((r) => renderingKey(r) === stored) ?? renderings[0] ?? null);
  return [selected, select];
}
