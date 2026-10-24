import { useEffect, type RefObject } from "react";

/** While `active`, a pointer press outside `root` calls `close`. */
export function useCloseOnOutsidePointer(root: RefObject<HTMLElement>, active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [root, active, close]);
}
