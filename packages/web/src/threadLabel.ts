import { threadTargetLabel, type Thread } from "@redline/shared";

export function threadWhere(thread: Pick<Thread, "target">): string {
  return threadTargetLabel(thread.target);
}
