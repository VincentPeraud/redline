import { useCallback, useEffect, useState } from "react";

/** A per-viewer on/off choice remembered across reloads under `key`; `initial` applies until the viewer chooses. */
export function useStoredToggle(key: string, initial: boolean): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : stored === "1";
  });
  useEffect(() => {
    localStorage.setItem(key, on ? "1" : "0");
  }, [key, on]);
  const toggle = useCallback(() => setOn((value) => !value), []);
  return [on, toggle];
}
