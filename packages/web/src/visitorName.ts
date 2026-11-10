const KEY = "redline:visitor-name";

/** The name a generic-link visitor gave at their first comment, remembered on this device. */
export const rememberedVisitorName = (): string => localStorage.getItem(KEY) ?? "";
export const rememberVisitorName = (name: string): void => localStorage.setItem(KEY, name);
