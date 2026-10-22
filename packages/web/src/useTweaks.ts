import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TWEAKS_PATH,
  parseTweaks,
  resolveTweakValues,
  type Manifest,
  type SetTweakRequest,
  type TweakValue,
  type TweakValues,
} from "@redline/shared";

const COMMIT_DELAY_MS = 300;

/**
 * Tweak values of a page. A change applies at once (local state, pushed to the artboards) and is saved to the
 * server after a short pause, which records one version with origin "tweak".
 */
export function useTweaks(pageId: string, manifest: Manifest | null, files: Record<string, string>, onSaved: () => void) {
  const [stored, setStored] = useState<TweakValues>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(0);
  const tweaksHash = files[TWEAKS_PATH];

  useEffect(() => {
    if (tweaksHash === undefined) {
      setStored({});
      return;
    }
    let cancelled = false;
    void fetch(`/api/pages/${pageId}/files/${TWEAKS_PATH}`)
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled && timers.current.size === 0 && inFlight.current === 0) setStored(parseTweaks(text));
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, tweaksHash]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const values = useMemo(() => (manifest ? resolveTweakValues(manifest, stored) : {}), [manifest, stored]);

  const setValue = useCallback(
    (id: string, value: TweakValue) => {
      setStored((current) => ({ ...current, [id]: value }));
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          inFlight.current += 1;
          const request: SetTweakRequest = { id, value };
          void fetch(`/api/pages/${pageId}/tweaks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          }).finally(() => {
            inFlight.current -= 1;
            onSaved();
          });
        }, COMMIT_DELAY_MS),
      );
    },
    [pageId, onSaved],
  );

  return { values, setValue };
}
