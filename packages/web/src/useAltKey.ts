import { useEffect, useState } from "react";

/** True while the Alt key is held in this page (released when the window loses focus). */
export function useAltKey(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => event.key === "Alt" && setHeld(true);
    const up = (event: KeyboardEvent) => event.key === "Alt" && setHeld(false);
    const release = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
}
