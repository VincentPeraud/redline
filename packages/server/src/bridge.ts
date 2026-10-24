import { designSystemTokensUrlPath, HOVER_FINISH, hoverLabelCss, hoverOutlineCss } from "@redline/shared";

/**
 * Script injected into every served artboard HTML. Artboards run in a sandboxed iframe with an
 * opaque origin, so the web UI cannot touch their DOM: it talks to this bridge by postMessage.
 *
 * Parent -> artboard: { type: "redline:set-mode", picking: boolean, alt: boolean }  (alt: the Alt key is held in the parent page, where keyboard focus usually is)
 *                     { type: "redline:set-pins", pins: [{ id, selector, xPct, yPct }] }
 *                     { type: "redline:set-links", selectors: string[] | null }  (play mode: clicks on a match are reported, not performed)
 *                     { type: "redline:set-tweaks", values: { [tweakId]: string | number | boolean } }  (full set; applied as --tweak-<id> CSS variables, data-tweak-<id> attributes on <html>, window.redlineTweaks and a "redline:tweaks" window event)
 *                     (comment mode, and Alt held in interactive mode, draw the hover outline and label in an overlay of the artboard document)
 * Artboard -> parent: { type: "redline:ready" }
 *                     { type: "redline:picked", selector, elementName, xPct, yPct }  (elementName: role + short visible text, e.g. bouton « Continuer »)
 *                     { type: "redline:pin-positions", positions: [{ id, xPct, yPct, matched }] }
 *                     { type: "redline:link", selector }
 *                     { type: "redline:doc-height", height }  (height of the whole page in pixels; sent on load and whenever it changes)
 *
 * Plain ES5 on purpose: it is served as-is to the browser.
 */
export const BRIDGE_PATH = "/__redline/bridge.js";

export const BRIDGE_SOURCE = `(function () {
  var picking = false;
  var forwardWheel = false;
  var pins = [];
  var linkSelectors = null;

  function docSize() {
    var root = document.documentElement;
    return { w: root.scrollWidth || 1, h: root.scrollHeight || 1 };
  }

  var lastHeight = 0;

  function reportHeight() {
    var root = document.documentElement;
    var height = Math.ceil(Math.max(root.offsetHeight || 0, document.body ? document.body.scrollHeight : 0));
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      send({ type: "redline:doc-height", height: height });
    }
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

  var NAME_MAX = 30;

  function clean(text) {
    return String(text || "").replace(/\\s+/g, " ").trim();
  }

  function shorten(text) {
    var value = clean(text);
    return value.length > NAME_MAX ? value.slice(0, NAME_MAX).replace(/\\s+$/, "") + "\\u2026" : value;
  }

  function labelOf(el) {
    var aria = el.getAttribute("aria-label");
    if (clean(aria)) return aria;
    if (el.id) {
      var labels = document.getElementsByTagName("label");
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].getAttribute("for") === el.id && clean(labels[i].textContent)) return labels[i].textContent;
      }
    }
    var wrapping = el.closest("label");
    if (wrapping && clean(wrapping.textContent)) return wrapping.textContent;
    return el.getAttribute("placeholder");
  }

  function ownText(el) {
    var text = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) text += el.childNodes[i].nodeValue;
    }
    return text;
  }

  function partsOf(target) {
    var el = target.closest ? target.closest("button, a[href], h1, h2, h3, h4, h5, h6, input, textarea, select, img, svg, [role=button]") : null;
    var role = "bloc";
    var text = "";
    if (!el) {
      el = target;
      text = ownText(el);
    } else {
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "img" || tag === "svg") {
        role = "image";
      } else if (tag === "input" && ["button", "submit", "reset"].indexOf(type) !== -1) {
        role = "bouton";
        text = el.value || el.getAttribute("aria-label");
      } else if (tag === "input" || tag === "textarea" || tag === "select") {
        role = "champ";
        text = labelOf(el);
      } else if (tag === "a") {
        role = "lien";
        text = el.textContent;
      } else if (/^h[1-6]$/.test(tag)) {
        role = "titre";
        text = el.textContent;
      } else {
        role = "bouton";
        text = el.textContent || el.getAttribute("aria-label");
      }
    }
    return { role: role, text: shorten(text) };
  }

  function nameOf(target) {
    var parts = partsOf(target);
    return parts.text === "" ? parts.role : parts.role + " \\u00ab " + parts.text + " \\u00bb";
  }

  function labelFor(target) {
    var parts = partsOf(target);
    var role = parts.role.charAt(0).toUpperCase() + parts.role.slice(1);
    return parts.text === "" ? role : role + " \\u00b7 " + parts.text;
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
    reportHeight();
  }

  function matchLink(target) {
    for (var el = target; el && el.nodeType === 1; el = el.parentElement) {
      for (var i = 0; i < linkSelectors.length; i++) {
        try { if (el.matches(linkSelectors[i])) return linkSelectors[i]; } catch (e) {}
      }
    }
    return null;
  }

  var OUTLINE_CSS = ${JSON.stringify(hoverOutlineCss())};
  var LABEL_CSS = ${JSON.stringify(hoverLabelCss())};
  var LABEL_OFFSET_X = ${HOVER_FINISH.labelOffsetX};
  var LABEL_OFFSET_Y = ${HOVER_FINISH.labelOffsetY};
  var hoverRoot = null;
  var hoverTarget = null;
  var altHeld = false;

  function hoverParts() {
    if (hoverRoot && hoverRoot.parentNode) return hoverRoot;
    hoverRoot = document.createElement("div");
    hoverRoot.id = "__redline-hover";
    hoverRoot.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none";
    var outline = document.createElement("div");
    outline.setAttribute("data-part", "outline");
    var label = document.createElement("div");
    label.setAttribute("data-part", "label");
    hoverRoot.appendChild(outline);
    hoverRoot.appendChild(label);
    document.documentElement.appendChild(hoverRoot);
    return hoverRoot;
  }

  function hoverEnabled() {
    return (picking || altHeld) && !linkSelectors;
  }

  function hideHover() {
    if (hoverRoot) hoverRoot.style.display = "none";
  }

  function drawHover() {
    var el = hoverTarget;
    if (!el || !hoverEnabled() || !el.isConnected || el === document.documentElement || el === document.body) {
      hideHover();
      return;
    }
    var rect = el.getBoundingClientRect();
    var root = hoverParts();
    root.style.display = "";
    var outline = root.firstChild;
    var label = root.lastChild;
    var radius = window.getComputedStyle(el).borderRadius;
    outline.style.cssText = "position: fixed; left: " + rect.left + "px; top: " + rect.top + "px; width: " + rect.width + "px; height: " + rect.height + "px; border-radius: " + (radius || "0") + "; " + OUTLINE_CSS;
    label.textContent = labelFor(el);
    var left = Math.max(1, rect.left + LABEL_OFFSET_X);
    var top = Math.max(1, rect.top + LABEL_OFFSET_Y);
    label.style.cssText = "position: fixed; left: " + left + "px; top: " + top + "px; " + LABEL_CSS;
  }

  function hoverAt(event) {
    altHeld = !!event.altKey;
    hoverTarget = event.target && event.target.nodeType === 1 ? event.target : null;
    drawHover();
  }

  document.addEventListener("mousemove", hoverAt, true);
  document.addEventListener("mouseout", function (event) {
    if (event.relatedTarget) return;
    hoverTarget = null;
    hideHover();
  }, true);
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Alt") return;
    altHeld = true;
    drawHover();
  }, true);
  document.addEventListener("keyup", function (event) {
    if (event.key !== "Alt") return;
    altHeld = false;
    drawHover();
  }, true);
  window.addEventListener("blur", function () {
    altHeld = false;
    drawHover();
  });
  window.addEventListener("scroll", drawHover, true);

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
      elementName: nameOf(event.target),
      xPct: pct(event.clientX + (window.scrollX || 0), size.w),
      yPct: pct(event.clientY + (window.scrollY || 0), size.h)
    });
  }, true);

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === "redline:set-mode") {
      picking = !!event.data.picking;
      altHeld = !!event.data.alt;
      forwardWheel = !!event.data.forwardWheel;
      document.documentElement.style.cursor = picking ? "crosshair" : "";
      drawHover();
    } else if (event.data.type === "redline:set-links") {
      linkSelectors = event.data.selectors || null;
    } else if (event.data.type === "redline:set-tweaks") {
      applyTweaks(event.data.values || {});
    } else if (event.data.type === "redline:set-pins") {
      pins = event.data.pins || [];
      reportPins();
    }
  });

  // True when an element under the cursor (a list, a carousel) can still scroll that way. The document itself
  // does not count: on the canvas, the artboard as a whole pans with the canvas.
  function scrollsInside(el, dx, dy) {
    for (; el && el.nodeType === 1 && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      var style = window.getComputedStyle(el);
      var canY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
      var canX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
      if (canY && (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : dy < 0 && el.scrollTop > 0)) return true;
      if (canX && (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : dx < 0 && el.scrollLeft > 0)) return true;
    }
    return false;
  }

  // The canvas pans and zooms on the wheel, but the iframe swallows it: hand it over (pinch comes as ctrl+wheel),
  // except while a scroll area of the artboard can take it. Deltas go in pixels, whatever unit the wheel used.
  window.addEventListener("wheel", function (event) {
    if (!forwardWheel) return;
    var pinch = event.ctrlKey || event.metaKey;
    if (!pinch && scrollsInside(event.target, event.deltaX, event.deltaY)) return;
    event.preventDefault();
    var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    send({
      type: "redline:wheel",
      deltaX: event.deltaX * unit,
      deltaY: event.deltaY * unit,
      deltaMode: 0,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      clientX: event.clientX,
      clientY: event.clientY
    });
  }, { passive: false });

  window.addEventListener("resize", function () {
    drawHover();
    reportPins();
    reportHeight();
  });
  window.addEventListener("load", reportHeight);
  if (typeof ResizeObserver === "function") {
    var observer = new ResizeObserver(reportHeight);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  send({ type: "redline:ready" });
  reportHeight();
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
