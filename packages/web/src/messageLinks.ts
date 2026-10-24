import { parseRoute } from "./router.js";

export interface PageAddress {
  kind: "address";
  url: string;
  pageId: string;
  artboard?: string;
  play?: string;
  renderingParam?: string;
}

export type MessageSegment = { kind: "text"; text: string } | { kind: "link"; url: string } | PageAddress;

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

function addressOf(url: string, origin: string): PageAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  const route = parseRoute(parsed.hash);
  if (route.name !== "page") return null;
  return {
    kind: "address",
    url,
    pageId: route.pageId,
    ...(route.artboard === undefined ? {} : { artboard: route.artboard }),
    ...(route.play === undefined ? {} : { play: route.play }),
    ...(route.renderingParam === undefined ? {} : { renderingParam: route.renderingParam }),
  };
}

/** Cuts a Claude message into text, plain links and addresses of this Redline server that point at a page or an artboard. */
export function splitMessageLinks(body: string, origin: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (match.index > last) segments.push({ kind: "text", text: body.slice(last, match.index) });
    segments.push(addressOf(url, origin) ?? { kind: "link", url });
    last = match.index + url.length;
  }
  if (last < body.length) segments.push({ kind: "text", text: body.slice(last) });
  return segments;
}
