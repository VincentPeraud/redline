import { designSystemTokensUrlPath } from "@redline/shared";

/**
 * Script injected into every served artboard HTML. Artboards run in a sandboxed iframe with an
 * opaque origin, so the web UI cannot touch their DOM: it talks to this bridge by postMessage.
 *
 * Parent -> artboard: { type: "redline:set-mode", picking: boolean }
 *                     { type: "redline:set-pins", pins: [{ id, selector, xPct, yPct }] }
 *                     { type: "redline:set-links", selectors: string[] | null }  (play mode: clicks on a match are reported, not performed)
 *                     { type: "redline:set-tweaks", values: { [tweakId]: string | number | boolean } }  (full set; applied as --tweak-<id> CSS variables, data-tweak-<id> attributes on <html>, window.redlineTweaks and a "redline:tweaks" window event)
 * Artboard -> parent: { type: "redline:ready" }
 *                     { type: "redline:picked", selector, xPct, yPct }
 *                     { type: "redline:pin-positions", positions: [{ id, xPct, yPct, matched }] }
 *                     { type: "redline:link", selector }
 *
 * Plain ES5 on purpose: it is served as-is to the browser.
 */
export const BRIDGE_PATH = "/__redline/bridge.js";

export const BRIDGE_SOURCE = `(function () {
  var picking = false;
  var pins = [];
  var linkSelectors = null;

  function docSize() {
    var root = document.documentElement;
    return { w: root.scrollWidth || 1, h: root.scrollHeight || 1 };
  }

  function pct(value, total) {
    return Math.min(100, Math.max(0, Math.round((value / total) * 100 * 100) / 100));
  }

  function escapeIdent(value) {
    return value.replace(/[^\\w-]/g, function (c) { return "\\\\" + c; });
  }

  function selectorFor(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id) {
        parts.unshift("#" + escapeIdent(el.id));
        break;
      }
      var part = el.tagName.toLowerCase();
      var siblings = el.parentElement
        ? Array.prototype.filter.call(el.parentElement.children, function (c) { return c.tagName === el.tagName; })
        : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")";
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }

  function send(message) {
    window.parent.postMessage(message, "*");
  }

  function locate(pin) {
    var el = null;
    try { el = document.querySelector(pin.selector); } catch (e) { el = null; }
    if (!el) return { id: pin.id, xPct: pin.xPct, yPct: pin.yPct, matched: false };
    var rect = el.getBoundingClientRect();
    var size = docSize();
    return {
      id: pin.id,
      xPct: 100,
      yPct: pct(rect.top + rect.height / 2 + (window.scrollY || 0), size.h),
      matched: true
    };
  }

  function reportPins() {
    send({ type: "redline:pin-positions", positions: pins.map(locate) });
  }

  var tweakIds = [];

  function applyTweaks(values) {
    var root = document.documentElement;
    tweakIds.forEach(function (id) {
      root.style.removeProperty("--tweak-" + id);
      root.removeAttribute("data-tweak-" + id);
    });
    tweakIds = Object.keys(values);
    tweakIds.forEach(function (id) {
      var value = values[id];
      root.style.setProperty("--tweak-" + id, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
      root.setAttribute("data-tweak-" + id, String(value));
    });
    window.redlineTweaks = values;
    window.dispatchEvent(new CustomEvent("redline:tweaks", { detail: values }));
  }

  function matchLink(target) {
    for (var el = target; el && el.nodeType === 1; el = el.parentElement) {
      for (var i = 0; i < linkSelectors.length; i++) {
        try { if (el.matches(linkSelectors[i])) return linkSelectors[i]; } catch (e) {}
      }
    }
    return null;
  }

  document.addEventListener("click", function (event) {
    if (linkSelectors) {
      var link = matchLink(event.target);
      if (link !== null) {
        event.preventDefault();
        event.stopPropagation();
        send({ type: "redline:link", selector: link });
      }
      return;
    }
    if (!picking && !event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    var size = docSize();
    send({
      type: "redline:picked",
      selector: selectorFor(event.target),
      xPct: pct(event.clientX + (window.scrollX || 0), size.w),
      yPct: pct(event.clientY + (window.scrollY || 0), size.h)
    });
  }, true);

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === "redline:set-mode") {
      picking = !!event.data.picking;
      document.documentElement.style.cursor = picking ? "crosshair" : "";
    } else if (event.data.type === "redline:set-links") {
      linkSelectors = event.data.selectors || null;
    } else if (event.data.type === "redline:set-tweaks") {
      applyTweaks(event.data.values || {});
    } else if (event.data.type === "redline:set-pins") {
      pins = event.data.pins || [];
      reportPins();
    }
  });

  window.addEventListener("resize", reportPins);
  send({ type: "redline:ready" });
})();
`;

/** Adds the bridge script tag to an artboard HTML document. */
export function injectBridge(html: string): string {
  const tag = `<script src="${BRIDGE_PATH}"></script>`;
  const end = html.lastIndexOf("</body>");
  return end === -1 ? html + tag : html.slice(0, end) + tag + html.slice(end);
}

/** Links a design system's live tokens at the start of the document head, before the page's own styles. */
export function injectDesignSystem(html: string, designSystemId: string): string {
  const tag = `<link rel="stylesheet" href="${designSystemTokensUrlPath(designSystemId)}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}
