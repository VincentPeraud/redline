import { threadTargetLabel, type Thread } from "@redline/shared";

export function threadWhere(thread: Pick<Thread, "target">): string {
  return threadTargetLabel(thread.target);
}

/** Artboard file of a whole-artboard thread, the hook the chip on the name strip scrolls to. */
export const wholeArtboardOf = (thread: Thread) => (thread.target.kind === "artboard" ? thread.artboard : undefined);
