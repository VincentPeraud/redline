import { MANIFEST_PATH, parseManifest, type ManifestElement, type ManifestLink } from "@redline/shared";
import type { Store } from "./store.js";

const aimedArtboards = (elements: ManifestElement[]): { index: number; page: string; file: string }[] =>
  elements.flatMap((element, index) => (element.kind === "link" && "page" in element && element.file !== undefined ? [{ index, page: element.page, file: element.file }] : []));

const playLinksToOtherPages = (links: ManifestLink[], pageId: string): { index: number; page: string; to: string }[] =>
  links.flatMap((link, index) => (link.page !== undefined && link.page !== pageId ? [{ index, page: link.page, to: link.to }] : []));

/**
 * Error message when the manifest about to be published on `pageId` points at something of another page that does not exist, else null
 * (the entry is named). Only references the page's current manifest does not already carry are checked, so a target removed later
 * never fails an unrelated publish. Expects a manifest that already parsed (`manifestError`).
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
  const knownLinks = current === undefined ? [] : playLinksToOtherPages(parseManifest(store.blobText(current)).links, pageId);
  const projectId = store.getPage(pageId)?.projectId;
  for (const { index, page, to } of playLinksToOtherPages(parseManifest(text).links, pageId)) {
    if (knownLinks.some((k) => k.page === page && k.to === to)) continue;
    if (store.getPage(page)?.projectId !== projectId) return `links[${index}] aims at page ${page}, which is not a page of this project`;
    if (!store.hasArtboard(page, to)) return `links[${index}] aims at artboard "${to}", which is not an artboard of page ${page}`;
  }
  return null;
}
