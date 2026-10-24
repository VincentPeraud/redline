import { MANIFEST_PATH, parseManifest, type ManifestElement } from "@redline/shared";
import type { Store } from "./store.js";

const aimedArtboards = (elements: ManifestElement[]): { index: number; page: string; file: string }[] =>
  elements.flatMap((element, index) => (element.kind === "link" && "page" in element && element.file !== undefined ? [{ index, page: element.page, file: element.file }] : []));

/**
 * Error message when the manifest about to be published on `pageId` points at something of another page that does not exist, else null
 * (the entry is named). Only references the page's current manifest does not already carry are checked, so a target removed later
 * never fails an unrelated publish. Expects a manifest that already parsed (`manifestError`). Add the other cross-page checks here (play links).
 */
export function crossPageReferencesError(store: Store, pageId: string, files: Record<string, string>): string | null {
  const text = files[MANIFEST_PATH];
  if (text === undefined) return null;
  const current = store.getPage(pageId)?.version.files[MANIFEST_PATH];
  const known = current === undefined ? [] : aimedArtboards(parseManifest(store.blobText(current)).elements);
  for (const { index, page, file } of aimedArtboards(parseManifest(text).elements)) {
    if (known.some((k) => k.page === page && k.file === file)) continue;
    if (!store.hasArtboard(page, file)) return `elements[${index}] (link) aims at artboard "${file}", which is not an artboard of page ${page}`;
  }
  return null;
}
