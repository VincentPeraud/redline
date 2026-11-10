import { useEffect, useState } from "react";
import { pageGapsPath, type PageGaps } from "@redline/shared";

/** The design system gaps of a page's latest version; `refreshKey` changes when the page or its design system did. */
export function useGaps(pageId: string, refreshKey: string): PageGaps | null {
  const [report, setReport] = useState<PageGaps | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(pageGapsPath(pageId))
      .then((res) => (res.ok ? (res.json() as Promise<PageGaps>) : null))
      .then((next) => {
        if (!cancelled) setReport(next);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, refreshKey]);

  return report;
}
