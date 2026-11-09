import { forwardRef, useEffect, useRef, useState, type IframeHTMLAttributes } from "react";
import { ARTBOARD_CAPABILITY_SEGMENT, type ArtboardCapability } from "@redline/shared";

/** Asked again this long after a failed attempt. */
const RETRY_MS = 10_000;

let originRequest: Promise<string> | undefined;

function artboardOrigin(): Promise<string> {
  originRequest ??= fetch("/api/config")
    .then((res) => res.json() as Promise<{ artboardOrigin: string }>)
    .then((config) => config.artboardOrigin);
  return originRequest;
}

/** The capability of one project, kept fresh for as long as someone listens. */
interface Pass {
  capability: string;
  listeners: Set<(capability: string) => void>;
  timer?: ReturnType<typeof setTimeout>;
}

const passes = new Map<string, Pass>();

async function refresh(projectId: string, pass: Pass): Promise<void> {
  let next = RETRY_MS;
  try {
    const res = await fetch(`/api/projects/${projectId}/artboard-capability`);
    if (res.ok) {
      const issued = (await res.json()) as ArtboardCapability;
      pass.capability = issued.capability;
      pass.listeners.forEach((listener) => listener(issued.capability));
      next = issued.renewAfterMs;
    }
  } catch {
    // Offline for a moment: the next attempt comes soon.
  }
  if (passes.get(projectId) === pass) pass.timer = setTimeout(() => void refresh(projectId, pass), next);
}

function listen(projectId: string, listener: (capability: string) => void): () => void {
  let pass = passes.get(projectId);
  if (!pass) {
    pass = { capability: "", listeners: new Set() };
    passes.set(projectId, pass);
    void refresh(projectId, pass);
  }
  pass.listeners.add(listener);
  if (pass.capability) listener(pass.capability);
  const kept = pass;
  return () => {
    kept.listeners.delete(listener);
    if (kept.listeners.size === 0) {
      clearTimeout(kept.timer);
      passes.delete(projectId);
    }
  };
}

/**
 * Where the artboards of a project are served: the artboard origin plus the project's viewing capability.
 * Empty until both are known. The capability is renewed in the background, so the value changes over time: see `ArtboardIframe`.
 */
export function useArtboardOrigin(projectId: string | undefined): string {
  const [origin, setOrigin] = useState("");
  const [capability, setCapability] = useState("");
  useEffect(() => {
    let cancelled = false;
    void artboardOrigin().then((value) => !cancelled && setOrigin(value));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setCapability("");
    if (projectId === undefined) return;
    return listen(projectId, setCapability);
  }, [projectId]);
  return origin && capability ? `${origin}/${ARTBOARD_CAPABILITY_SEGMENT}/${capability}` : "";
}

const CAPABILITY_IN_URL = new RegExp(`/${ARTBOARD_CAPABILITY_SEGMENT}/[^/]+`);

/** Two artboard urls are the same artboard when only their capability differs. */
export function sameArtboard(a: string, b: string): boolean {
  return a.replace(CAPABILITY_IN_URL, "") === b.replace(CAPABILITY_IN_URL, "");
}

/** An artboard iframe that does not reload when only the capability in its url is renewed. */
export const ArtboardIframe = forwardRef<HTMLIFrameElement, IframeHTMLAttributes<HTMLIFrameElement>>(function ArtboardIframe({ src = "", ...props }, ref) {
  const kept = useRef(src);
  if (!sameArtboard(kept.current, src)) kept.current = src;
  return <iframe ref={ref} {...props} src={kept.current} />;
});
