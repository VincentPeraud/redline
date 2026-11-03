import { designSystemComponentsUrlPath, diffusionFileUrlPath, designSystemTokensUrlPath, projectComponentsUrlPath, projectStyleUrlPath, GAP_OUTLINE_CSS, HOVER_FINISH, MARK_FINISH, hoverLabelCss, hoverOutlineCss, markBadgeCss } from "@redline/shared";

/**
 * Script injected into every served artboard HTML. Artboards run in a sandboxed iframe with an
 * opaque origin, so the web UI cannot touch their DOM: it talks to this bridge by postMessage.
 *
 * Parent -> artboard: { type: "redline:set-mode", picking: boolean, selecting: boolean, alt: boolean }  (selecting: the conversation's selection mode, which hovers and picks like comment mode; alt: the Alt key is held in the parent page, where keyboard focus usually is)
 *                     { type: "redline:set-pins", pins: [{ id, selector, xPct, yPct }] }
 *                     { type: "redline:set-marks", marks: [{ number, selector }] }  (numbered selection marks, drawn whenever there are some)
 *                     { type: "redline:set-gap", selector: string | null }  (outlines the element a design system gap points at, and answers redline:gap-rect when it exists)
 *                     { type: "redline:set-links", selectors: string[] | null }  (play mode: clicks on a match are reported, not performed)
 *                     { type: "redline:set-tweaks", values: { [tweakId]: string | number | boolean } }  (full set; applied as --tweak-<id> CSS variables, data-tweak-<id> attributes on <html>, window.redlineTweaks and a "redline:tweaks" window event)
 *                     (comment mode, and Alt held in interactive mode, draw the hover outline and label in an overlay of the artboard document)
 * Artboard -> parent: { type: "redline:ready" }
 *                     { type: "redline:picked", selector, elementName, xPct, yPct }  (elementName: role + short visible text, e.g. bouton « Continuer »)
 *                     { type: "redline:escape" }  (Escape pressed in selection mode: the iframe holds the keyboard focus, so the parent cannot hear it)
 *                     { type: "redline:key", key: "ArrowLeft" | "ArrowRight" }  (arrow pressed with no modifier outside a text field: the iframe holds the keyboard focus, so play mode cannot hear it)
 *                     { type: "redline:pin-positions", positions: [{ id, xPct, yPct, matched }] }
 *                     { type: "redline:link", selector }
 *                     { type: "redline:gap-rect", x, y, width, height }  (box of the element outlined by redline:set-gap, in page pixels)
 *                     { type: "redline:doc-height", height }  (height of the whole page in pixels; sent on load and whenever it changes)
 *                     { type: "redline:errors", errors: string[] }  (sent by the errors catcher, see ERRORS_SOURCE)
 *
 * Plain ES5 on purpose: it is served as-is to the browser.
 */
export const BRIDGE_PATH = "/__redline/bridge.js";

/** Served first in the head: catches what goes wrong before and after the bridge loads. */
export const ERRORS_PATH = "/__redline/errors.js";

/**
 * Catches the page's script errors, its promises rejected without a handler and its files that fail to load, as French
 * messages for the viewer (deduplicated, at most 20), and sends the whole list as { type: "redline:errors", errors }
 * whenever it grows. The bridge sends it once more when it is ready, so an artboard without errors reports an empty list.
 * Nothing is stored: it is what this viewer's browser saw. Plain ES5, like the bridge.
 */
export const ERRORS_SOURCE = `(function () {
  var MAX_ERRORS = 20;
  var MAX_LENGTH = 300;
  var errors = [];
  var MISSING = { IMG: "Image introuvable", SCRIPT: "Script introuvable", LINK: "Feuille de style introuvable", VIDEO: "M\u00e9dia introuvable", AUDIO: "M\u00e9dia introuvable", SOURCE: "M\u00e9dia introuvable" };

  function report() {
    window.parent.postMessage({ type: "redline:errors", errors: errors.slice() }, "*");
  }

  function add(message) {
    var text = String(message).replace(/\\s+/g, " ").trim();
    if (text.length > MAX_LENGTH) text = text.slice(0, MAX_LENGTH) + "\u2026";
    if (text === "" || errors.length >= MAX_ERRORS || errors.indexOf(text) !== -1) return;
    errors.push(text);
    report();
  }

  function describe(reason) {
    if (reason && typeof reason === "object" && typeof reason.message === "string") return (reason.name || "Error") + ": " + reason.message;
    return String(reason);
  }

  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && target.nodeType === 1) {
      var file = target.getAttribute("src") || target.getAttribute("href") || "";
      add((MISSING[target.tagName] || "Fichier introuvable") + " : " + file);
      return;
    }
    var message = String(event.message || "").replace(/^Uncaught /, "");
    if (message === "Script error." || message === "") {
      add("Erreur dans un script charg\u00e9 (le navigateur en masque le d\u00e9tail)");
      return;
    }
    var where = "";
    if (event.filename && event.filename !== location.href) where = " (" + event.filename.split("/").pop() + ")";
    add(message + (event.lineno ? " \u00b7 ligne " + event.lineno : "") + where);
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    add("Promesse rejet\u00e9e : " + describe(event.reason));
  });

  window.__redlineErrors = { report: report, add: add };
})();
`;

export const BRIDGE_SOURCE = `(function () {
  var picking = false;
  var selecting = false;
  var marks = [];
  var forwardWheel = false;
  var pins = [];
  var linkSelectors = null;

  function docSize() {
    var root = document.documentElement;
    return { w: root.scrollWidth || 1, h: root.scrollHeight || 1 };
  }

  var lastHeight = 0;

  function reportHeight() {
    drawMarks();
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

  function firstTextLine(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (clean(node.nodeValue)) return node.nodeValue;
    }
    return "";
  }

  // A container's text: its first heading, else its first strong text, else its first text line.
  function blockText(el) {
    var emphasis = el.querySelector("h1, h2, h3, h4, h5, h6") || el.querySelector("strong, b");
    if (emphasis && clean(emphasis.textContent)) return emphasis.textContent;
    return clean(ownText(el)) ? ownText(el) : firstTextLine(el);
  }

  function isTransparent(color) {
    return !color || color === "transparent" || /^rgba\\(\\s*0,\\s*0,\\s*0,\\s*0\\s*\\)$/.test(color);
  }

  // A visually boxed block: a background or a border, with rounded corners.
  function isCard(el) {
    var style = window.getComputedStyle(el);
    var rounded = parseFloat(style.borderTopLeftRadius) > 0 || parseFloat(style.borderRadius) > 0;
    var bordered = parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" && style.borderTopStyle !== "";
    return rounded && (bordered || !isTransparent(style.backgroundColor));
  }

  var TITLE_MAX = 60;

  // A short block of text, not inline, that is bold or clearly larger than its parent's text.
  function isTitleLike(el) {
    var style = window.getComputedStyle(el);
    if (style.display === "inline" || clean(el.textContent).length > TITLE_MAX) return false;
    var weight = style.fontWeight === "bold" ? 700 : parseFloat(style.fontWeight);
    if (weight >= 600) return true;
    var size = parseFloat(style.fontSize);
    var parentSize = el.parentElement ? parseFloat(window.getComputedStyle(el.parentElement).fontSize) : NaN;
    return size >= parentSize * 1.25;
  }

  function partsOf(target) {
    var el = target.closest ? target.closest("button, a[href], h1, h2, h3, h4, h5, h6, input, textarea, select, img, svg, [role=button]") : null;
    var role = "bloc";
    var text = "";
    if (!el) {
      el = target;
      text = blockText(el);
      if (isCard(el)) role = "carte";
      else if (clean(text) !== "" && isTitleLike(el)) role = "titre";
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

  function inTextField(target) {
    var tag = target && target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!(target && (target.isContentEditable || (target.closest && target.closest("[contenteditable]:not([contenteditable=false])"))));
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
    return (picking || selecting || altHeld) && !linkSelectors;
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

  var BADGE_CSS = ${JSON.stringify(markBadgeCss())};
  var BADGE_OFFSET = ${MARK_FINISH.badgeOffset};
  var marksRoot = null;

  function drawMarks() {
    if (!marksRoot || !marksRoot.parentNode) {
      if (marks.length === 0) return;
      marksRoot = document.createElement("div");
      marksRoot.id = "__redline-marks";
      marksRoot.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none";
      document.documentElement.appendChild(marksRoot);
    }
    marksRoot.innerHTML = "";
    marks.forEach(function (mark) {
      var el = null;
      try { el = document.querySelector(mark.selector); } catch (e) { el = null; }
      if (!el) return;
      var rect = el.getBoundingClientRect();
      var box = document.createElement("div");
      box.setAttribute("data-mark", String(mark.number));
      var outline = document.createElement("div");
      outline.setAttribute("data-part", "outline");
      outline.style.cssText = "position: fixed; left: " + rect.left + "px; top: " + rect.top + "px; width: " + rect.width + "px; height: " + rect.height + "px; border-radius: " + (window.getComputedStyle(el).borderRadius || "0") + "; " + OUTLINE_CSS;
      var badge = document.createElement("div");
      badge.setAttribute("data-part", "badge");
      badge.textContent = String(mark.number);
      badge.style.cssText = "position: fixed; left: " + (rect.left + BADGE_OFFSET) + "px; top: " + (rect.top + BADGE_OFFSET) + "px; " + BADGE_CSS;
      box.appendChild(outline);
      box.appendChild(badge);
      marksRoot.appendChild(box);
    });
  }

  var GAP_CSS = ${JSON.stringify(GAP_OUTLINE_CSS)};
  var gapSelector = null;
  var gapOutline = null;

  function drawGap() {
    var el = null;
    if (gapSelector) {
      try { el = document.querySelector(gapSelector); } catch (e) { el = null; }
    }
    if (!el) {
      if (gapOutline && gapOutline.parentNode) gapOutline.parentNode.removeChild(gapOutline);
      gapOutline = null;
      return null;
    }
    var rect = el.getBoundingClientRect();
    if (!gapOutline || !gapOutline.parentNode) {
      gapOutline = document.createElement("div");
      gapOutline.id = "__redline-gap";
      document.documentElement.appendChild(gapOutline);
    }
    gapOutline.style.cssText = "position: fixed; z-index: 2147483646; pointer-events: none; left: " + rect.left + "px; top: " + rect.top + "px; width: " + rect.width + "px; height: " + rect.height + "px; border-radius: " + (window.getComputedStyle(el).borderRadius || "0") + "; " + GAP_CSS;
    return rect;
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
    if (event.key === "Escape" && selecting) send({ type: "redline:escape" });
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !inTextField(event.target)) send({ type: "redline:key", key: event.key });
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
  window.addEventListener("scroll", function () {
    drawHover();
    drawMarks();
  }, true);

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
    if (!picking && !selecting && !event.altKey) return;
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
      selecting = !!event.data.selecting;
      altHeld = !!event.data.alt;
      forwardWheel = !!event.data.forwardWheel;
      document.documentElement.style.cursor = picking || selecting ? "crosshair" : "";
      drawHover();
    } else if (event.data.type === "redline:set-links") {
      linkSelectors = event.data.selectors || null;
    } else if (event.data.type === "redline:set-tweaks") {
      applyTweaks(event.data.values || {});
    } else if (event.data.type === "redline:set-marks") {
      marks = event.data.marks || [];
      drawMarks();
    } else if (event.data.type === "redline:set-gap") {
      gapSelector = typeof event.data.selector === "string" ? event.data.selector : null;
      var gapBox = drawGap();
      if (gapBox) send({ type: "redline:gap-rect", x: gapBox.left + (window.scrollX || 0), y: gapBox.top + (window.scrollY || 0), width: gapBox.width, height: gapBox.height });
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

  // On the canvas (the canvas asked for the wheel), a drag over the artboard's text selects nothing: text fields keep
  // their own selection, and play mode and previews leave the artboard as it is.
  document.addEventListener("selectstart", function (event) {
    if (!forwardWheel) return;
    var target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    if (target && target.closest && target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    event.preventDefault();
  });

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
    drawMarks();
    drawGap();
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
  if (window.__redlineErrors) window.__redlineErrors.report();
  reportHeight();
})();
`;

/**
 * Inserts `tag` as early as the document allows: at the start of its head, else right after its <html> tag, else after its
 * doctype (a script before the doctype would switch the page to quirks mode), else at the very start.
 */
function insertAtHeadStart(html: string, tag: string): string {
  const anchor = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (!anchor) return tag + html;
  const at = anchor.index + anchor[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

/** Adds the errors catcher at the start of an artboard HTML document's head, before any of its scripts, and the bridge at the end of its body. */
export function injectBridge(html: string): string {
  const withCatcher = insertAtHeadStart(html, `<script src="${ERRORS_PATH}"></script>`);
  const tag = `<script src="${BRIDGE_PATH}"></script>`;
  const end = withCatcher.lastIndexOf("</body>");
  return end === -1 ? withCatcher + tag : withCatcher.slice(0, end) + tag + withCatcher.slice(end);
}

/**
 * Links, at the start of the document head and before the page's own styles: the design system's tokens and components
 * (the files of `diffusion` when given, else the live draft), then, when the project has a style (`projectId`), its tokens and its components (they win over the design system by CSS order).
 */
export function injectDesignSystem(html: string, designSystemId: string | undefined, projectId?: string, diffusion?: number): string {
  const link = (href: string) => `<link rel="stylesheet" href="${href}">`;
  const tag =
    (designSystemId === undefined
      ? ""
      : diffusion === undefined
        ? link(designSystemTokensUrlPath(designSystemId)) + link(designSystemComponentsUrlPath(designSystemId))
        : link(diffusionFileUrlPath(designSystemId, diffusion, "tokens.css")) + link(diffusionFileUrlPath(designSystemId, diffusion, "components.css"))) +
    (projectId === undefined ? "" : link(projectStyleUrlPath(projectId)) + link(projectComponentsUrlPath(projectId)));
  return insertAtHeadStart(html, tag);
}
