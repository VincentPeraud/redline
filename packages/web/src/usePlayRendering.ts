import { useCallback, useEffect, useState } from "react";
import { renderingKey, type ArtboardRendering } from "@redline/shared";

const STORAGE_KEY = "redline:play-rendering";
const NONE = "none";

/**
 * The format this viewer plays a responsive artboard in; remembered across reloads. `null` = "Aucun" (the whole window).
 * A remembered format the artboard does not declare falls back to its first one.
 */
export function usePlayRendering(renderings: ArtboardRendering[]): [ArtboardRendering | null, (rendering: ArtboardRendering | null) => void] {
  const [stored, setStored] = useState(() => localStorage.getItem(STORAGE_KEY));
  useEffect(() => {
    if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
  }, [stored]);
  const select = useCallback((rendering: ArtboardRendering | null) => setStored(rendering ? renderingKey(rendering) : NONE), []);
  const selected = stored === NONE ? null : (renderings.find((r) => renderingKey(r) === stored) ?? renderings[0] ?? null);
  return [selected, select];
}
