import { useCallback, useEffect, useRef, useState } from "react";

/** How close to the bottom still counts as "at the bottom", in pixels. */
const SLACK = 40;

/**
 * Keeps a scrolling list pinned to its bottom while content is added (a reply sent, Claude's text streaming in),
 * as long as the reader was already at the bottom; scrolling up lets them read in peace.
 * `startAtBottom` scrolls down when the list first appears (a conversation opens on its latest message).
 */
export function useStickToBottom<T extends HTMLElement>({ startAtBottom = false } = {}): (node: T | null) => void {
  const [node, setNode] = useState<T | null>(null);
  const stuck = useRef(startAtBottom);

  useEffect(() => {
    if (!node) return;
    let lastTop = 0;
    const toBottom = () => {
      node.scrollTop = node.scrollHeight;
      lastTop = node.scrollTop;
    };
    const onScroll = () => {
      stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight <= SLACK;
      lastTop = node.scrollTop;
    };
    if (stuck.current) toBottom();
    else onScroll();
    // Content changes do not fire `scroll`: follow them while the reader sits at the bottom. A scroll up made
    // by code just before (a clicked pin bringing its thread into view) has not fired `scroll` yet: it unpins too.
    const follow = new MutationObserver(() => {
      if (node.scrollTop < lastTop) stuck.current = false;
      if (stuck.current) toBottom();
    });
    node.addEventListener("scroll", onScroll);
    follow.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      follow.disconnect();
    };
  }, [node]);

  return useCallback((next: T | null) => setNode(next), []);
}
