import { useCallback, useEffect, useState } from "react";
import { COPIED_BUBBLE_MS } from "./copyLink.js";

/** Which "Lien copié" bubble is up (`value` names where, e.g. a file), for `COPIED_BUBBLE_MS`; showing it again restarts the timer. */
export function useCopiedBubble<T = true>(): [T | null, (value?: T) => void] {
  const [shown, setShown] = useState<{ value: T; at: number } | null>(null);
  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), COPIED_BUBBLE_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  const show = useCallback((value = true as T) => setShown({ value, at: Date.now() }), []);
  return [shown?.value ?? null, show];
}
