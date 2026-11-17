import { useSyncExternalStore } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastSpec {
  message: string;
  /** An error stays until it is closed or retried; the others close by themselves. */
  tone?: "info" | "error";
  action?: ToastAction;
}

export interface Toast extends ToastSpec {
  id: number;
  tone: "info" | "error";
  /** Plays the exit animation; the toast is removed once it is over. */
  closing: boolean;
}

/** How long an information toast stays. */
export const TOAST_MS = 6_000;
/** Length of the exit animation. */
export const TOAST_EXIT_MS = 160;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: readonly Toast[]): void {
  toasts = next;
  listeners.forEach((listener) => listener());
}

/** Closes a toast with its exit animation. */
export function dismissToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id && !toast.closing)) return;
  publish(toasts.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)));
  setTimeout(() => publish(toasts.filter((toast) => toast.id !== id)), TOAST_EXIT_MS);
}

/** Shows a toast at the bottom of the screen; an information toast closes by itself after `TOAST_MS`. Returns its id. */
export function showToast(spec: ToastSpec): number {
  const id = nextId++;
  const tone = spec.tone ?? "info";
  publish([...toasts, { ...spec, id, tone, closing: false }]);
  if (tone === "info") setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

/** The toasts on screen, oldest first. */
export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
}
