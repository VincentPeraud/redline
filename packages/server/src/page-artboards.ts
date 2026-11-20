import { MANIFEST_PATH, componentNameOf, defaultManifest, parseManifest } from "@redline/shared";

/** An artboard of a page: its file, the name shown for it (its title, else its file) and its HTML. */
export interface PageArtboard {
  file: string;
  place: string;
  content: string;
}

/** The artboards of a page's `files`, in manifest order: HTML files that exist and are not component files. */
export function pageArtboards(files: Record<string, string>): PageArtboard[] {
  const manifest = files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(files[MANIFEST_PATH]);
  return manifest.artboards.flatMap((entry) => {
    const content = files[entry.file];
    return content === undefined || !entry.file.endsWith(".html") || componentNameOf(entry.file) !== null ? [] : [{ file: entry.file, place: entry.title ?? entry.file, content }];
  });
}
