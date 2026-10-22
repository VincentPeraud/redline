import type { Thread } from "@redline/shared";

/** "<artboard> · <element name>", falling back to the exact selector for threads without a name. */
export function threadWhere(thread: Pick<Thread, "artboard" | "selector" | "elementName">): string {
  return `${thread.artboard} · ${thread.elementName ?? thread.selector}`;
}
