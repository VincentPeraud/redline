import { renderingKey, type ArtboardRendering, type PageViewSettings, type ResponsiveFormat } from "@redline/shared";

const shownIn = (settings: PageViewSettings, file: string, rendering: ArtboardRendering) =>
  settings.renderingOverrides[file]?.[renderingKey(rendering)] ?? !settings.hiddenFormats.includes(rendering.format);

/** Keys of the renderings of a frame that are hidden: the first one stays when the settings would hide them all. */
export function hiddenRenderingKeys(renderings: readonly ArtboardRendering[], settings: PageViewSettings, file: string): Set<string> {
  const visible = renderings.filter((r) => shownIn(settings, file, r));
  const kept = visible.length > 0 ? visible : renderings.slice(0, 1);
  return new Set(renderings.filter((r) => !kept.includes(r)).map(renderingKey));
}

/** The settings after a chip click: the frame's choice for that rendering flips; the last visible rendering stays. */
export function toggleRendering(settings: PageViewSettings, file: string, renderings: readonly ArtboardRendering[], key: string): PageViewSettings {
  const hidden = hiddenRenderingKeys(renderings, settings, file);
  if (!hidden.has(key) && hidden.size === renderings.length - 1) return settings;
  const rendering = renderings.find((r) => renderingKey(r) === key)!;
  const { [key]: _previous, ...others } = settings.renderingOverrides[file] ?? {};
  const wantShown = hidden.has(key);
  const overrides = wantShown === !settings.hiddenFormats.includes(rendering.format) ? others : { ...others, [key]: wantShown };
  const { [file]: _frame, ...otherFrames } = settings.renderingOverrides;
  return { ...settings, renderingOverrides: Object.keys(overrides).length === 0 ? otherFrames : { ...otherFrames, [file]: overrides } };
}

/** The settings after a "Rendus" menu choice: it applies to every frame and clears their exceptions for that format. */
export function setFormatShown(settings: PageViewSettings, format: ResponsiveFormat, shown: boolean): PageViewSettings {
  const hiddenFormats = shown ? settings.hiddenFormats.filter((f) => f !== format) : [...new Set([...settings.hiddenFormats, format])];
  const renderingOverrides: PageViewSettings["renderingOverrides"] = {};
  for (const [file, byKey] of Object.entries(settings.renderingOverrides)) {
    const kept = Object.fromEntries(Object.entries(byKey).filter(([key]) => !key.startsWith(`${format}-`)));
    if (Object.keys(kept).length > 0) renderingOverrides[file] = kept;
  }
  return { hiddenFormats, renderingOverrides };
}
