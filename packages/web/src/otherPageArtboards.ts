import { useEffect, useState } from "react";
import { MANIFEST_PATH, defaultManifest, parseManifest, type Page } from "@redline/shared";

export interface PageSummary {
  title: string;
  artboardTitles: Map<string, string>;
}

const FRESH_MS = 5000;
const pages = new Map<string, { at: number; summary: Promise<PageSummary | null> }>();
const manifestTitlesByBlob = new Map<string, Map<string, string>>();
/** Titles of artboards seen on any page, so a pill keeps a name once the artboard is gone. */
const lastKnownTitles = new Map<string, string>();

async function artboardTitles(page: Page): Promise<Map<string, string>> {
  const blob = page.version.files[MANIFEST_PATH];
  const cached = blob === undefined ? undefined : manifestTitlesByBlob.get(blob);
  if (cached) return cached;
  const manifest =
    blob === undefined ? defaultManifest(Object.keys(page.version.files)) : parseManifest(await (await fetch(`/api/pages/${encodeURIComponent(page.id)}/files/${MANIFEST_PATH}`)).text());
  const titles = new Map(manifest.artboards.map((artboard) => [artboard.file, artboard.title ?? artboard.file]));
  if (blob !== undefined) manifestTitlesByBlob.set(blob, titles);
  return titles;
}

async function fetchSummary(pageId: string): Promise<PageSummary | null> {
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}`);
  if (!res.ok) return null;
  const page = (await res.json()) as Page;
  const titles = await artboardTitles(page);
  rememberArtboardTitles(pageId, titles);
  return { title: page.title, artboardTitles: titles };
}

/** Title and artboard titles of a page, fetched lazily and shared between pills; `null` when the page does not exist. Rejects when the fetch fails (not cached, so the next call retries). */
export function loadPageSummary(pageId: string): Promise<PageSummary | null> {
  const known = pages.get(pageId);
  if (known && Date.now() - known.at < FRESH_MS) return known.summary;
  const summary = fetchSummary(pageId);
  pages.set(pageId, { at: Date.now(), summary });
  summary.catch(() => pages.delete(pageId));
  return summary;
}

export function lastKnownTitle(pageId: string, file: string): string | undefined {
  return lastKnownTitles.get(`${pageId}/${file}`);
}

export function rememberArtboardTitles(pageId: string, titles: Iterable<[string, string]>) {
  for (const [file, title] of titles) lastKnownTitles.set(`${pageId}/${file}`, title);
}

/** `undefined` while loading; `null` when the page does not exist or could not be loaded. */
export function usePageSummary(pageId: string, skip: boolean): PageSummary | null | undefined {
  const [summary, setSummary] = useState<PageSummary | null | undefined>(undefined);
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    loadPageSummary(pageId)
      .catch(() => null)
      .then((loaded) => {
        if (!cancelled) setSummary(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, skip]);
  return summary;
}
