import { createHash } from "node:crypto";
import { designSystemComponentsUrlPath, diffusionFileUrlPath, designSystemTokensUrlPath, projectComponentsUrlPath, projectStyleUrlPath, GAP_OUTLINE_CSS, HOVER_FINISH, INSTANCE_ANCHOR_SEPARATOR, INSTANCE_FINISH, MARK_FINISH, hoverLabelCss, hoverOutlineCss, instanceLabelCss, instanceOutlineCss, markBadgeCss } from "@redline/shared";

/**
 * Script injected into every served artboard HTML. Artboards run in a sandboxed iframe with an
 * opaque origin, so the web UI cannot touch their DOM: it talks to this bridge by postMessage.
 *
 * Parent -> artboard: { type: "redline:set-mode", picking: boolean, selecting: boolean, alt: boolean }  (selecting: the conversation's selection mode, which hovers and picks like comment mode; alt: the Alt key is held in the parent page, where keyboard focus usually is)
 *                     { type: "redline:set-pins", pins: [{ id, selector, elementName?, xPct, yPct, instanceState? }] }  (a selector "<instance> >>> <path>" anchors inside a component instance, see INSTANCE_ANCHOR_SEPARATOR; instanceState: the state the thread was written in)
 *                     { type: "redline:replay-state", id }  (sets the remembered instance state of the pin with that id, then reports the pins again)
 *                     { type: "redline:set-marks", marks: [{ number, selector }] }  (numbered selection marks, drawn whenever there are some)
 *                     { type: "redline:set-compare-markers", visible: boolean, markers: [{ number, selector }] }  (before / after view: numbered dashed markers on the touched zones)
 *                     { type: "redline:set-gap", selector: string | null }  (outlines the element a design system gap points at, and answers redline:gap-rect when it exists)
 *                     { type: "redline:set-links", selectors: string[] | null }  (play mode: clicks on a match are reported, not performed)
 *                     { type: "redline:set-tweaks", values: { [tweakId]: string | number | boolean } }  (full set; applied as --tweak-<id> CSS variables, data-tweak-<id> attributes on <html>, window.redlineTweaks and a "redline:tweaks" window event)
 *                     (comment mode, and Alt held in interactive mode, draw the hover outline and label in an overlay of the artboard document)
 * Artboard -> parent: { type: "redline:ready" }
 *                     { type: "redline:picked", selector, elementName, xPct, yPct, instanceState? }  (elementName: role + short visible text, e.g. bouton « Continuer »; instanceState: [{ selector, attributes }] of the instances that left their state at load, e.g. { open: "" })
 *                     { type: "redline:escape" }  (Escape pressed in selection mode: the iframe holds the keyboard focus, so the parent cannot hear it)
 *                     { type: "redline:key", key: "ArrowLeft" | "ArrowRight" }  (arrow pressed with no modifier outside a text field: the iframe holds the keyboard focus, so play mode cannot hear it)
 *                     { type: "redline:pin-positions", positions: [{ id, xPct, yPct, matched, elementGone?, elementLost?, hidden?, missingState? }] }  (a matched pin sits on its element's top-right corner; when the element at the selector no longer has the thread's elementName, the element of that name is used instead; elementLost: none has it, the pin keeps its stored position; elementGone: the element inside the instance no longer exists, the pin sits on the instance; hidden: the pin's remembered state does not hold now; missingState: indexes of the state entries that cannot be replayed any more)
 *                     { type: "redline:link", selector }
 *                     { type: "redline:gap-rect", x, y, width, height }  (box of the element outlined by redline:set-gap, in page pixels)
 *                     { type: "redline:doc-height", height }  (height of the whole page in pixels; sent on load and whenever it changes)
 *                     { type: "redline:top-colour", colour }  (background drawn at the top of the viewport, as Safari on iOS 26 tints its status bar with it; sent on load and whenever it changes, scrolling included)
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
    reportTopColour();
  }

  var lastTopColour = "";

  // A colour with real opacity (a faint overlay does not set the tone), else null.
  function opaque(colour) {
    var m = /rgba?\\(([^)]*)\\)/.exec(colour || "");
    if (!m) return null;
    var parts = m[1].split(/[\\s,\\/]+/).filter(Boolean);
    var alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;
    return alpha >= 0.5 ? m[0] : null;
  }

  // Background of an element: its colour, else the first colour of its gradient.
  function backgroundOf(el) {
    var style = window.getComputedStyle(el);
    return opaque(style.backgroundColor) || opaque(style.backgroundImage);
  }

  // What is drawn at the top centre of the viewport, front first, decorative layers with pointer-events: none included
  // (a header band is often one): hit testing skips them, so they are made hittable for the time of the lookup.
  function elementsAtTop() {
    if (typeof document.elementsFromPoint !== "function") return [];
    var hittable = document.createElement("style");
    hittable.textContent = "* { pointer-events: auto !important; }";
    (document.head || document.documentElement).appendChild(hittable);
    var found = document.elementsFromPoint(window.innerWidth / 2, 1);
    hittable.parentNode.removeChild(hittable);
    return found;
  }

  function reportTopColour() {
    var stack = elementsAtTop();
    var colour = null;
    for (var i = 0; !colour && i < stack.length; i++) colour = backgroundOf(stack[i]);
    if (!colour && document.body) colour = backgroundOf(document.body);
    if (!colour) colour = backgroundOf(document.documentElement) || "rgb(255, 255, 255)";
    if (colour !== lastTopColour) {
      lastTopColour = colour;
      send({ type: "redline:top-colour", colour: colour });
    }
  }

  function pct(value, total) {
    return Math.min(100, Math.max(0, Math.round((value / total) * 100 * 100) / 100));
  }

  function escapeIdent(value) {
    return value.replace(/[^\\w-]/g, function (c) { return "\\\\" + c; });
  }

  var SEPARATOR = ${JSON.stringify(INSTANCE_ANCHOR_SEPARATOR)};

  // The outermost component instance containing el (or el itself), else null. The runtime marks instances with __redlineInstance.
  function instanceHostOf(el) {
    var host = null;
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.__redlineInstance) host = node;
    }
    return host;
  }

  function plainSelectorFor(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id) {
        parts.unshift((el.__redlineInstance ? el.tagName.toLowerCase() : "") + "#" + escapeIdent(el.id));
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

  // Path from the host's children down to el, without ids: the same template gives the same ids to every instance.
  function pathWithin(el, host) {
    var parts = [];
    for (; el && el !== host; el = el.parentElement) {
      var part = el.tagName.toLowerCase();
      var siblings = Array.prototype.filter.call(el.parentElement.children, function (c) { return c.tagName === el.tagName; });
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")";
      parts.unshift(part);
    }
    return parts.join(" > ");
  }

  // Inside an instance: the instance's selector, then the path within what it renders.
  function selectorFor(el) {
    var host = instanceHostOf(el);
    if (host && host !== el) return plainSelectorFor(host) + SEPARATOR + pathWithin(el, host);
    return plainSelectorFor(el);
  }

  function query(root, selector) {
    try { return root.querySelector(selector); } catch (e) { return null; }
  }

  // { el, gone }: gone is true when the element inside an instance no longer exists and el is the instance.
  function resolve(selector) {
    var at = selector.indexOf(SEPARATOR);
    if (at === -1) return { el: query(document, selector), gone: false };
    var host = query(document, selector.slice(0, at));
    if (!host) return { el: null, gone: false };
    var inner = query(host, ":scope > " + selector.slice(at + SEPARATOR.length));
    return inner ? { el: inner, gone: false } : { el: host, gone: true };
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

  // Remembered state: the attributes an instance can be in (open, selected, its settings) that differ from what it had at load.
  var STATE_ATTRIBUTES = ["open", "selected"];
  var initialStates = [];

  function instances() {
    return Array.prototype.filter.call(document.querySelectorAll("*"), function (el) { return !!el.__redlineInstance; });
  }

  function attributesOf(host) {
    var names = STATE_ATTRIBUTES.concat(host.__redlineInstance.definition.settings.map(function (s) { return s.name; }));
    var attributes = {};
    names.forEach(function (name) {
      if (host.hasAttribute(name)) attributes[name] = host.getAttribute(name);
    });
    return attributes;
  }

  window.addEventListener("load", function () {
    initialStates = instances().map(function (host) { return { host: host, attributes: attributesOf(host) }; });
  });

  function currentState() {
    var state = [];
    instances().forEach(function (host) {
      var now = attributesOf(host);
      var initial = initialStates.filter(function (s) { return s.host === host; })[0];
      var before = initial ? initial.attributes : {};
      var changed = {};
      var any = false;
      Object.keys(now).forEach(function (name) {
        if (before[name] !== now[name]) { changed[name] = now[name]; any = true; }
      });
      if (any) state.push({ selector: selectorFor(host), attributes: changed });
    });
    return state;
  }

  // The instance of a state entry when it can still be put in that state: it exists, and each setting is still defined with that value.
  function replayable(entry) {
    var found = resolve(entry.selector);
    var host = found.el;
    if (!host || found.gone || !host.__redlineInstance) return null;
    var settings = host.__redlineInstance.definition.settings;
    var ok = Object.keys(entry.attributes).every(function (name) {
      if (STATE_ATTRIBUTES.indexOf(name) !== -1) return true;
      var setting = settings.filter(function (s) { return s.name === name; })[0];
      return !!setting && (!setting.options || setting.options.indexOf(entry.attributes[name]) !== -1);
    });
    return ok ? host : null;
  }

  function stateHolds(entry, host) {
    return Object.keys(entry.attributes).every(function (name) { return host.getAttribute(name) === entry.attributes[name]; });
  }

  function replayState(pin) {
    (pin.instanceState || []).forEach(function (entry) {
      var host = replayable(entry);
      if (host) Object.keys(entry.attributes).forEach(function (name) { host.setAttribute(name, entry.attributes[name]); });
    });
  }

  // The selector's last tag and its depth from body (null when it does not start at body), to choose between same-named elements.
  function shapeOf(selector) {
    var steps = selector.split(">").map(function (step) { return step.trim(); });
    var tag = /^([a-z][a-z0-9-]*)/i.exec(steps[steps.length - 1] || "");
    return { tag: tag ? tag[1].toLowerCase() : null, depth: steps[0] === "body" ? steps.length - 1 : null };
  }

  function depthOf(el) {
    var depth = 0;
    for (var node = el; node && node !== document.body; node = node.parentElement) depth++;
    return depth;
  }

  // The element named \`name\` (as nameOf names it) closest in shape to the stored selector: same tag first, then the nearest depth, then the deepest.
  function findByName(name, selector) {
    var shape = shapeOf(selector);
    var best = null;
    var bestScore = null;
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || nameOf(el) !== name) continue;
      var depth = depthOf(el);
      var score = [
        shape.tag && el.tagName.toLowerCase() !== shape.tag ? 1 : 0,
        shape.depth === null ? 0 : Math.abs(depth - shape.depth),
        -depth
      ];
      if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && (score[1] < bestScore[1] || (score[1] === bestScore[1] && score[2] < bestScore[2])))) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function locate(pin) {
    var missing = [];
    var holds = true;
    (pin.instanceState || []).forEach(function (entry, index) {
      var host = replayable(entry);
      if (!host) missing.push(index);
      else if (!stateHolds(entry, host)) holds = false;
    });
    var found = resolve(pin.selector);
    var lost = false;
    if (pin.elementName && pin.selector.indexOf(SEPARATOR) === -1 && (!found.el || nameOf(found.el) !== pin.elementName)) {
      var byName = findByName(pin.elementName, pin.selector);
      lost = !byName;
      found = { el: byName, gone: false };
    }
    var el = found.el;
    if (!holds) return { id: pin.id, xPct: pin.xPct, yPct: pin.yPct, matched: !!el, hidden: true, missingState: missing };
    var position = { id: pin.id, xPct: pin.xPct, yPct: pin.yPct, matched: false };
    if (lost) position.elementLost = true;
    if (el) {
      // On the element's top-right corner, so the pin reads as belonging to it.
      var rect = el.getBoundingClientRect();
      var size = docSize();
      position = {
        id: pin.id,
        xPct: pct(rect.left + rect.width + (window.scrollX || 0), size.w),
        yPct: pct(rect.top + (window.scrollY || 0), size.h),
        matched: true
      };
      if (found.gone) position.elementGone = true;
    }
    if (missing.length > 0) position.missingState = missing;
    return position;
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

  var INSTANCE_OUTLINE_CSS = ${JSON.stringify(instanceOutlineCss())};
  var INSTANCE_LABEL_CSS = ${JSON.stringify(instanceLabelCss())};
  var INSTANCE_LABEL_OFFSET_X = ${INSTANCE_FINISH.labelOffsetX};
  var INSTANCE_LABEL_OFFSET_Y = ${INSTANCE_FINISH.labelOffsetY};
  var instanceRoot = null;

  function instanceParts() {
    if (instanceRoot && instanceRoot.parentNode) return instanceRoot;
    instanceRoot = document.createElement("div");
    instanceRoot.id = "__redline-hover-instance";
    instanceRoot.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none";
    var outline = document.createElement("div");
    outline.setAttribute("data-part", "outline");
    var label = document.createElement("div");
    label.setAttribute("data-part", "label");
    instanceRoot.appendChild(outline);
    instanceRoot.appendChild(label);
    document.documentElement.appendChild(instanceRoot);
    return instanceRoot;
  }

  // "ui-modal \u00b7 confirm": the instance's tag, then its id, else the value of its first setting.
  function instanceLabelOf(host) {
    var tag = host.tagName.toLowerCase();
    if (host.id) return tag + " \u00b7 " + host.id;
    var settings = host.__redlineInstance.definition.settings;
    if (settings.length === 0) return tag;
    var name = settings[0].name;
    if (!host.hasAttribute(name)) return tag;
    var value = host.getAttribute(name);
    return tag + " \u00b7 " + (value === "" ? name : value);
  }

  function hideHover() {
    if (hoverRoot) hoverRoot.style.display = "none";
    if (instanceRoot) instanceRoot.style.display = "none";
  }

  // The hovered element sits in a component instance: the instance is outlined too, its label on the top-right corner so it never covers the element's own label.
  function drawInstanceHover(el) {
    var host = instanceHostOf(el);
    if (!host) {
      if (instanceRoot) instanceRoot.style.display = "none";
      return;
    }
    var rect = host.getBoundingClientRect();
    var root = instanceParts();
    root.style.display = "";
    root.firstChild.style.cssText = "position: fixed; left: " + rect.left + "px; top: " + rect.top + "px; width: " + rect.width + "px; height: " + rect.height + "px; border-radius: " + (window.getComputedStyle(host).borderRadius || "0") + "; " + INSTANCE_OUTLINE_CSS;
    root.lastChild.textContent = instanceLabelOf(host);
    root.lastChild.style.cssText = "position: fixed; left: " + Math.max(1, rect.left + INSTANCE_LABEL_OFFSET_X) + "px; top: " + Math.max(1, rect.top + INSTANCE_LABEL_OFFSET_Y) + "px; " + INSTANCE_LABEL_CSS;
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
    drawInstanceHover(el);
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
      var found = resolve(mark.selector);
      if (!found.el || found.gone) return;
      var el = found.el;
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

  // Before / after view: numbered dashed markers on the zones a change touches, in document coordinates so they scroll with the page.
  var COMPARE_COLOR = ${JSON.stringify(HOVER_FINISH.color)};
  var compareMarkers = [];
  var compareVisible = false;

  function markerRadius(el, rect) {
    var raw = window.getComputedStyle(el).borderTopLeftRadius || "0";
    if (raw.indexOf("%") !== -1) return raw;
    var px = parseFloat(raw) || 0;
    return (px > 0 ? px + 3 : 6) + "px";
  }

  function drawCompare() {
    var root = document.getElementById("__redline-compare");
    if (root) root.remove();
    if (!compareVisible || compareMarkers.length === 0) return;
    root = document.createElement("div");
    root.id = "__redline-compare";
    root.style.cssText = "position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none";
    var sx = window.scrollX || 0;
    var sy = window.scrollY || 0;
    compareMarkers.forEach(function (marker) {
      var found = resolve(marker.selector);
      if (!found.el || found.gone) return;
      var rect = found.el.getBoundingClientRect();
      var outline = document.createElement("div");
      outline.setAttribute("data-part", "outline");
      outline.style.cssText = "position: absolute; box-sizing: border-box; left: " + (rect.left + sx - 5) + "px; top: " + (rect.top + sy - 5) + "px; width: " + (rect.width + 10) + "px; height: " + (rect.height + 10) + "px; border: 2px dashed " + COMPARE_COLOR + "; border-radius: " + markerRadius(found.el, rect);
      var badge = document.createElement("div");
      badge.setAttribute("data-part", "badge");
      badge.textContent = String(marker.number);
      badge.style.cssText = "position: absolute; left: " + (rect.right + sx - 6) + "px; top: " + (rect.top + sy - 14) + "px; width: 20px; height: 20px; border-radius: 50%; background: " + COMPARE_COLOR + "; color: #FFFFFF; font: 600 11px/20px Inter, system-ui, sans-serif; text-align: center";
      root.appendChild(outline);
      root.appendChild(badge);
    });
    document.documentElement.appendChild(root);
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
    reportTopColour();
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
    var picked = {
      type: "redline:picked",
      selector: selectorFor(event.target),
      elementName: nameOf(event.target),
      xPct: pct(event.clientX + (window.scrollX || 0), size.w),
      yPct: pct(event.clientY + (window.scrollY || 0), size.h)
    };
    var state = currentState();
    if (state.length > 0) picked.instanceState = state;
    send(picked);
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
    } else if (event.data.type === "redline:set-compare-markers") {
      compareMarkers = event.data.markers || [];
      compareVisible = !!event.data.visible;
      drawCompare();
    } else if (event.data.type === "redline:set-gap") {
      gapSelector = typeof event.data.selector === "string" ? event.data.selector : null;
      var gapBox = drawGap();
      if (gapBox) send({ type: "redline:gap-rect", x: gapBox.left + (window.scrollX || 0), y: gapBox.top + (window.scrollY || 0), width: gapBox.width, height: gapBox.height });
    } else if (event.data.type === "redline:set-pins") {
      pins = event.data.pins || [];
      reportPins();
    } else if (event.data.type === "redline:replay-state") {
      pins.filter(function (pin) { return pin.id === event.data.id; }).forEach(replayState);
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
    drawCompare();
    drawGap();
    reportPins();
    reportHeight();
  });
  window.addEventListener("load", function () { reportHeight(); drawCompare(); });
  // A pin with a remembered state shows and hides as the instances enter and leave that state.
  if (typeof MutationObserver === "function") {
    var statePending = false;
    new MutationObserver(function () {
      if (statePending || !pins.some(function (pin) { return pin.instanceState; })) return;
      statePending = true;
      setTimeout(function () { statePending = false; reportPins(); }, 0);
    }).observe(document, { attributes: true, subtree: true });
  }
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

/** Short fingerprint of a script's source: its URL changes with it, so no cache (a CDN in front of a shared Redline) serves an old copy. */
function versionOf(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 10);
}

const ERRORS_URL = `${ERRORS_PATH}?v=${versionOf(ERRORS_SOURCE)}`;
const BRIDGE_URL = `${BRIDGE_PATH}?v=${versionOf(BRIDGE_SOURCE)}`;

/** Adds the errors catcher at the start of an artboard HTML document's head, before any of its scripts, and the bridge at the end of its body. */
export function injectBridge(html: string, base = ""): string {
  const withCatcher = insertAtHeadStart(html, `<script src="${base}${ERRORS_URL}"></script>`);
  const tag = `<script src="${base}${BRIDGE_URL}"></script>`;
  const end = withCatcher.lastIndexOf("</body>");
  return end === -1 ? withCatcher + tag : withCatcher.slice(0, end) + tag + withCatcher.slice(end);
}

/**
 * Links, at the start of the document head and before the page's own styles: the design system's tokens and components
 * (the files of `diffusion` when given, else the live draft), then, when the project has a style (`projectId`), its tokens and its components (they win over the design system by CSS order).
 */
export function injectDesignSystem(html: string, designSystemId: string | undefined, projectId?: string, diffusion?: number, base = ""): string {
  const link = (href: string) => `<link rel="stylesheet" href="${base}${href}">`;
  const tag =
    (designSystemId === undefined
      ? ""
      : diffusion === undefined
        ? link(designSystemTokensUrlPath(designSystemId)) + link(designSystemComponentsUrlPath(designSystemId))
        : link(diffusionFileUrlPath(designSystemId, diffusion, "tokens.css")) + link(diffusionFileUrlPath(designSystemId, diffusion, "components.css"))) +
    (projectId === undefined ? "" : link(projectStyleUrlPath(projectId)) + link(projectComponentsUrlPath(projectId)));
  return insertAtHeadStart(html, tag);
}
