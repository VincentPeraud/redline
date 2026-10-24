/** Whether a key event comes from a field the viewer types in, where single-letter shortcuts must stay out of the way. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return element !== null && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT" || element.isContentEditable);
}
