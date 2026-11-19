import { createHash } from "node:crypto";
import { INSTANCES_DATA_ID } from "./instances.js";

/**
 * Component sandbox (the "Essayer" card of a component's artboard). `/pages/<id>/components/<name>.html?sandbox=1` serves
 * the component's file as one lone instance: the file's head (its styles, without its scripts), the body kept inert in a
 * `<template data-redline-sandbox-source>` (read for the slot texts of its first instances, never run), and a stage holding
 * `<ui-<name>>`. The usual tokens, components css, instance runtime and bridge are injected around it; this script, served
 * after the runtime and before the bridge, talks to the card:
 *
 * Artboard -> parent: { type: "redline:sandbox-info", tag, defined, slots: [{ name, label?, fallback: { text, rich, tag? } }],
 *                       firstFills: { [slot]: { text, rich, tag? } }, sources: string[] }
 *                     (defined: false when no definition has the tag; sources: the template, the script and the style blocks,
 *                     where the card looks for the open and selected states)
 * Parent -> artboard: { type: "redline:sandbox-set", trial: { values, states?, slots? } }
 *                     (the instance is built again with those attributes and slot texts: a toggle is a boolean attribute, a
 *                     state an attribute, a text in the default slot a text node, in a named slot a <span slot="…">)
 *
 * Plain ES5, like the bridge.
 */
export const SANDBOX_PATH = "/__redline/sandbox.js";

export const SANDBOX_SOURCE = `(function () {
  var stage = document.querySelector("[data-redline-sandbox-stage]");
  var source = document.querySelector("template[data-redline-sandbox-source]");
  if (!stage) return;
  var tag = stage.getAttribute("data-tag");
  var data = document.getElementById("${INSTANCES_DATA_ID}");
  var layers = data ? JSON.parse(data.textContent || "{}") : {};

  function find(list) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].tag === tag) return list[i];
    return null;
  }
  var definition = find(layers.project) || find(layers.designSystem);

  function contentOf(nodes) {
    var text = "";
    var first = null;
    nodes.forEach(function (node) {
      if (node.nodeType === 1 && !first) first = node;
      if (node.nodeType === 1 || node.nodeType === 3) text += node.textContent;
    });
    var content = { text: text.replace(/\\s+/g, " ").trim(), rich: first !== null };
    if (first) content.tag = first.localName;
    return content;
  }

  // A named slot is filled by an element carrying slot="name": its own text, rich when it holds an element or is an instance.
  function fillOf(instance, name) {
    var children = Array.prototype.slice.call(instance.childNodes);
    if (name === "") {
      var own = children.filter(function (node) { return !(node.nodeType === 1 && node.hasAttribute("slot")); });
      var content = contentOf(own);
      return content.text === "" && !content.rich ? null : content;
    }
    var holder = children.filter(function (node) { return node.nodeType === 1 && node.getAttribute("slot") === name; })[0];
    if (!holder) return null;
    if (holder.localName.indexOf("ui-") === 0) return { text: holder.textContent.replace(/\\s+/g, " ").trim(), rich: true, tag: holder.localName };
    var inner = contentOf(Array.prototype.slice.call(holder.childNodes));
    return inner.text === "" && !inner.rich ? null : inner;
  }

  var slots = [];
  var firstFills = {};
  var sources = [];
  if (definition) {
    var holder = document.createElement("template");
    holder.innerHTML = definition.template;
    Array.prototype.slice.call(holder.content.querySelectorAll("slot")).forEach(function (slot) {
      var name = slot.getAttribute("name") || "";
      if (slots.some(function (s) { return s.name === name; })) return;
      var entry = { name: name, fallback: contentOf(Array.prototype.slice.call(slot.childNodes)) };
      if (slot.hasAttribute("data-label")) entry.label = slot.getAttribute("data-label");
      slots.push(entry);
    });
    var instances = source ? Array.prototype.slice.call(source.content.querySelectorAll(tag)) : [];
    slots.forEach(function (slot) {
      for (var i = 0; i < instances.length; i++) {
        var fill = fillOf(instances[i], slot.name);
        if (fill) { firstFills[slot.name] = fill; return; }
      }
    });
    sources.push(definition.template);
    if (definition.script) sources.push(definition.script);
    Array.prototype.slice.call(document.querySelectorAll("style")).forEach(function (style) { sources.push(style.textContent || ""); });
  }

  window.parent.postMessage({ type: "redline:sandbox-info", tag: tag, defined: definition !== null, slots: slots, firstFills: firstFills, sources: sources }, "*");

  function build(trial) {
    var instance = document.createElement(tag);
    instance.id = "redline-sandbox";
    var values = trial.values || {};
    Object.keys(values).forEach(function (id) {
      var name = id.toLowerCase();
      var value = values[id];
      if (typeof value === "boolean") { if (value) instance.setAttribute(name, ""); }
      else instance.setAttribute(name, String(value));
    });
    var states = trial.states || {};
    Object.keys(states).forEach(function (state) { if (states[state]) instance.setAttribute(state, ""); });
    var texts = trial.slots || {};
    Object.keys(texts).forEach(function (name) {
      var text = texts[name];
      if (typeof text !== "string" || text.trim() === "") return;
      if (name === "") { instance.appendChild(document.createTextNode(text)); return; }
      var span = document.createElement("span");
      span.setAttribute("slot", name);
      span.textContent = text;
      instance.appendChild(span);
    });
    stage.replaceChildren(instance);
    if (window.__redlineRefresh) window.__redlineRefresh();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !event.data || event.data.type !== "redline:sandbox-set") return;
    build(event.data.trial || {});
  });
})();
`;

const SANDBOX_URL = `${SANDBOX_PATH}?v=${createHash("sha256").update(SANDBOX_SOURCE).digest("hex").slice(0, 10)}`;

/** Neutralises the file's own page layout: the stage centres the lone instance on a transparent page. */
const STAGE_STYLE =
  `<style data-redline-sandbox>html,body{margin:0!important;padding:0!important;background:transparent!important;min-height:0!important;height:auto!important;display:block!important;overflow-x:auto}` +
  `[data-redline-sandbox-stage]{display:flex;align-items:center;justify-content:center;min-height:120px;padding:24px;box-sizing:border-box}` +
  `[data-redline-sandbox-stage]>*{max-width:100%}</style>`;

/** The component file as a sandbox document for `tag` (see SANDBOX_SOURCE); the instance is built on the card's first message. */
export function sandboxDocument(html: string, tag: string): string {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const head = headMatch?.[1] ?? "";
  // A file without a <body> tag: everything but its head is the body.
  const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(html)?.[1] ?? (headMatch ? html.slice(headMatch.index + headMatch[0].length) : html).replace(/<!doctype[^>]*>|<\/?html\b[^>]*>/gi, "");
  const headWithoutScripts = head.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  // The component's style may hang on the page's theme (html[data-theme], body.dark): keep those attributes, never the body's own layout.
  const htmlAttributes = /<html\b([^>]*)>/i.exec(html)?.[1] ?? "";
  const bodyAttributes = [...(/<body\b([^>]*)>/i.exec(html)?.[1] ?? "").matchAll(/\s((?:class|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*'))/gi)].map((m) => ` ${m[1]}`).join("");
  // Templates nest, so the file's own <template data-component> stays inside the inert copy; its scripts never run there anyway.
  const inert = body.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  return (
    `<!doctype html><html${htmlAttributes}><head>${headWithoutScripts}${STAGE_STYLE}</head><body${bodyAttributes}>` +
    `<template data-redline-sandbox-source>${inert}</template>` +
    `<div data-redline-sandbox-stage data-tag="${tag}"></div>` +
    `</body></html>`
  );
}

/** Adds the sandbox script at the end of the body: after the instance runtime, before the bridge (which injects itself after). */
export function injectSandbox(html: string, base = ""): string {
  const tag = `<script src="${base}${SANDBOX_URL}"></script>`;
  const end = html.lastIndexOf("</body>");
  return end === -1 ? html + tag : html.slice(0, end) + tag + html.slice(end);
}
