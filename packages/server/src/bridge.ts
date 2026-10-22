/**
 * Script injected into every served artboard HTML. Artboards run in a sandboxed iframe with an
 * opaque origin, so the web UI cannot touch their DOM: it talks to this bridge by postMessage.
 *
 * Parent -> artboard: { type: "redline:set-mode", picking: boolean }
 *                     { type: "redline:set-pins", pins: [{ id, selector, xPct, yPct }] }
 * Artboard -> parent: { type: "redline:ready" }
 *                     { type: "redline:picked", selector, xPct, yPct }
 *                     { type: "redline:pin-positions", positions: [{ id, xPct, yPct, matched }] }
 *
 * Plain ES5 on purpose: it is served as-is to the browser.
 */
export const BRIDGE_PATH = "/__redline/bridge.js";

export const BRIDGE_SOURCE = `(function () {
  var picking = false;
  var pins = [];

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
      xPct: pct(rect.left + (window.scrollX || 0), size.w),
      yPct: pct(rect.top + (window.scrollY || 0), size.h),
      matched: true
    };
  }

  function reportPins() {
    send({ type: "redline:pin-positions", positions: pins.map(locate) });
  }

  document.addEventListener("click", function (event) {
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
