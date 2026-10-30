import { useEffect } from "react";

/**
 * Names the browser tab after the screen, most specific first: "Accueil · Lumora · Redline". Nothing is set while a part
 * is still loading (undefined), so the tab does not flash a half title; `null` parts are left out.
 */
export function useDocumentTitle(...parts: (string | null | undefined)[]): void {
  const ready = parts.every((part) => part !== undefined);
  const title = [...parts.filter((part): part is string => typeof part === "string" && part !== ""), "Redline"].join(" · ");
  useEffect(() => {
    if (ready) document.title = title;
  }, [ready, title]);
}
