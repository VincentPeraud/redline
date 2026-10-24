import { MANIFEST_PATH, defaultManifest, groupTitlesOf, parseManifest, readingOrder, renderingSlots, responsiveFrameLayout } from "@redline/shared";
import type { ServerApi } from "./server-api.js";

/** The page address, then one numbered line per artboard in canvas reading order: title, canvas address, play address. */
export function pageAddresses(api: ServerApi, pageId: string, files: Record<string, string>): string {
  const manifest = files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(files[MANIFEST_PATH]);
  const boxes = manifest.artboards.map((artboard) => ({
    file: artboard.file,
    title: artboard.title,
    ...(artboard.responsive ? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive)).frame : artboard),
  }));
  const lines = readingOrder(boxes, groupTitlesOf(manifest)).map(
    ({ number, file, title }) => `${number}. ${title ?? file} · canvas ${api.artboardUrl(pageId, file)} · play ${api.playUrl(pageId, file)}`,
  );
  return [`Page: ${api.pageUrl(pageId)}`, ...(lines.length ? ["Artboards, in reading order:", ...lines] : [])].join("\n");
}
