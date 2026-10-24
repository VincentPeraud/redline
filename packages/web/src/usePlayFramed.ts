import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "redline:play-framed";

/** Whether this viewer plays artboards inside their device frame ("Habillage"); remembered across reloads, on by default. */
export function usePlayFramed(): [boolean, () => void] {
  const [framed, setFramed] = useState(() => localStorage.getItem(STORAGE_KEY) !== "0");
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, framed ? "1" : "0");
  }, [framed]);
  const toggle = useCallback(() => setFramed((f) => !f), []);
  return [framed, toggle];
}
