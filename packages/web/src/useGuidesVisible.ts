import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "redline:guides";

/** Whether this viewer shows layout guides; remembered across reloads. */
export function useGuidesVisible(): [boolean, () => void] {
  const [visible, setVisible] = useState(() => localStorage.getItem(STORAGE_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
  }, [visible]);
  const toggle = useCallback(() => setVisible((v) => !v), []);
  return [visible, toggle];
}
