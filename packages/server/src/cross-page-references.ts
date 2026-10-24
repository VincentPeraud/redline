import { MANIFEST_PATH, parseManifest, type Manifest } from "@redline/shared";
import type { Store } from "./store.js";

interface Reference {
  /** Where the manifest says it, for the error message. */
  where: string;
  page: string;
  /** Artboard file aimed at, absent for a card that only names a page. */
  file?: string;
}

const referencesOf = (manifest: Manifest, pageId: string): Reference[] => [
  ...manifest.elements.flatMap((element, index): Reference[] =>
    element.kind === "link" && "page" in element ? [{ where: `elements[${index}] (link)`, page: element.page, file: element.file }] : [],
  ),
  ...manifest.links.flatMap((link, index): Reference[] => (link.page !== undefined && link.page !== pageId ? [{ where: `links[${index}]`, page: link.page, file: link.to }] : [])),
];

/**
 * Error message when the manifest about to be published on `pageId` points at something of another page that does not exist, else null
 * (the entry is named). Only references the page's current manifest does not already carry are checked, so a target removed later
 * never fails an unrelated publish. Expects a manifest that already parsed (`manifestError`).
 */
export function crossPageReferencesError(store: Store, pageId: string, files: Record<string, string>): string | null {
  const text = files[MANIFEST_PATH];
  if (text === undefined) return null;
  const page = store.getPage(pageId);
  const currentHash = page?.version.files[MANIFEST_PATH];
  const known = currentHash === undefined ? [] : referencesOf(parseManifest(store.blobText(currentHash)), pageId);
  for (const { where, page: target, file } of referencesOf(parseManifest(text), pageId)) {
    if (known.some((k) => k.page === target && k.file === file)) continue;
    if (store.getPage(target)?.projectId !== page?.projectId) return `${where} aims at page ${target}, which is not a page of this project`;
    if (file !== undefined && !store.hasArtboard(target, file)) return `${where} aims at artboard "${file}", which is not an artboard of page ${target}`;
  }
  return null;
}
