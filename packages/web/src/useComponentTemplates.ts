import { useEffect, useState } from "react";
import { componentNameOf } from "@redline/shared";

const TEMPLATE = /<template\b[^>]*\bdata-component\b/i;

/**
 * Whether each component file of the page (`components/<name>.html`) has a `<template data-component>`: only those can
 * be tried in the sandbox. A file is read again when its content hash changes; undefined until it has been read.
 */
export function useComponentTemplates(pageId: string, files: Record<string, string>): Record<string, boolean> {
  const [known, setKnown] = useState<Record<string, { hash: string; template: boolean }>>({});
  const components = Object.entries(files).filter(([file]) => componentNameOf(file) !== null);
  const key = components.map(([file, hash]) => `${file}@${hash}`).join("\n");

  useEffect(() => {
    let cancelled = false;
    const stale = components.filter(([file, hash]) => known[file]?.hash !== hash);
    void Promise.all(
      // A file that could not be read stays unknown (no button), never "no template".
      stale.map(async ([file, hash]) => {
        try {
          const res = await fetch(`/api/pages/${pageId}/files/${file}`);
          return res.ok ? [[file, { hash, template: TEMPLATE.test(await res.text()) }] as const] : [];
        } catch {
          return [];
        }
      }),
    ).then((read) => {
      const entries = read.flat();
      if (!cancelled && entries.length > 0) setKnown((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` sums up the component files and their hashes
  }, [pageId, key]);

  return Object.fromEntries(components.flatMap(([file]) => (known[file] ? [[file, known[file].template]] : [])));
}
