import type { InstanceLayers } from "@redline/shared";
import { projectComponents } from "./components.js";
import type { Store } from "./store.js";

/**
 * Instance runtime (component instances, ticket 01). Served on the artboard origin and injected at the end of the body
 * of every artboard that has definitions, right before the bridge, so the instances are already parsed when it runs.
 *
 * It reads the definitions from `<script type="application/json" id="redline-components">` (an `InstanceLayers`) and
 * defines one custom element per component tag, rendered in light DOM:
 *   - on first connect the instance keeps its authored children, applies the defaults of the settings it leaves out
 *     (a missing choice attribute takes the default, a toggle whose default is true gets its boolean attribute) and renders;
 *   - rendering moves the authored children into the template's slots (`slot="x"` to `<slot name="x">`, the rest into the
 *     default slot; an empty slot keeps its fallback content), replaces the `<slot>` elements and sets the result as the
 *     instance's children. The authored nodes are the same nodes at every render;
 *   - a change to a setting attribute renders again;
 *   - a tag written in the page resolves to the project's definition, then the design system's; a tag inside a design
 *     system template resolves to the design system's definition only. Nesting stops at MAX_DEPTH.
 *
 * Plain ES2015 (custom elements need `class`); it only runs in browsers that have them.
 */
export const INSTANCES_PATH = "/__redline/instances.js";

export const INSTANCES_DATA_ID = "redline-components";

export const INSTANCES_SOURCE = `(function () {
  var MAX_DEPTH = 10;
  var SCOPE_PAGE = "page";
  var SCOPE_DESIGN_SYSTEM = "designSystem";
  var data = document.getElementById("${INSTANCES_DATA_ID}");
  if (!data || typeof customElements === "undefined") return;
  var layers = JSON.parse(data.textContent || "{}");
  var designSystemScoped = new WeakSet();

  function definitionIn(list, tag) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].tag === tag) return list[i];
    return null;
  }

  // Returns { definition, scope } where scope is the one the definition's own template tags resolve with.
  function resolve(tag, scope) {
    if (scope === SCOPE_PAGE) {
      var own = definitionIn(layers.project, tag);
      if (own) return { definition: own, scope: SCOPE_PAGE };
    }
    var shared = definitionIn(layers.designSystem, tag);
    return shared ? { definition: shared, scope: SCOPE_DESIGN_SYSTEM } : null;
  }

  function depthOf(element) {
    var depth = 0;
    for (var node = element.parentElement; node; node = node.parentElement) if (node.__redlineInstance) depth++;
    return depth;
  }

  function slotOf(node) {
    return node.nodeType === 1 && node.hasAttribute("slot") ? node.getAttribute("slot") : "";
  }

  function hasContent(nodes) {
    return nodes.some(function (node) {
      return node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim() !== "");
    });
  }

  function applyDefaults(host, definition) {
    definition.settings.forEach(function (setting) {
      if (host.hasAttribute(setting.name) || setting.default === undefined) return;
      if (setting.type === "toggle") {
        if (setting.default === true) host.setAttribute(setting.name, "");
      } else {
        host.setAttribute(setting.name, String(setting.default));
      }
    });
  }

  function render(host, resolved) {
    var holder = document.createElement("template");
    holder.innerHTML = resolved.definition.template;
    var fragment = holder.content;
    var bySlot = {};
    host.__authored.forEach(function (node) {
      var name = slotOf(node);
      (bySlot[name] = bySlot[name] || []).push(node);
    });
    Array.prototype.slice.call(fragment.querySelectorAll("slot")).forEach(function (slot) {
      var nodes = bySlot[slot.getAttribute("name") || ""];
      slot.replaceWith.apply(slot, nodes && hasContent(nodes) ? nodes : Array.prototype.slice.call(slot.childNodes));
    });
    if (resolved.scope === SCOPE_DESIGN_SYSTEM) {
      Array.prototype.slice.call(fragment.querySelectorAll("*")).forEach(function (element) {
        if (element.localName.indexOf("ui-") === 0) designSystemScoped.add(element);
      });
    }
    host.replaceChildren(fragment);
  }

  function define(tag) {
    var observed = [];
    [layers.project, layers.designSystem].forEach(function (list) {
      var definition = definitionIn(list, tag);
      if (definition) definition.settings.forEach(function (setting) { if (observed.indexOf(setting.name) === -1) observed.push(setting.name); });
    });
    customElements.define(tag, class extends HTMLElement {
      static get observedAttributes() { return observed; }
      connectedCallback() {
        if (this.__redlineInstance) return;
        var resolved = resolve(tag, designSystemScoped.has(this) ? SCOPE_DESIGN_SYSTEM : SCOPE_PAGE);
        if (!resolved || depthOf(this) >= MAX_DEPTH) return;
        this.__redlineInstance = resolved;
        this.__authored = Array.prototype.slice.call(this.childNodes);
        applyDefaults(this, resolved.definition);
        render(this, resolved);
        this.__rendered = true;
      }
      attributeChangedCallback() {
        if (this.__rendered) render(this, this.__redlineInstance);
      }
    });
  }

  var tags = [];
  [layers.project, layers.designSystem].forEach(function (list) {
    (list || []).forEach(function (definition) { if (tags.indexOf(definition.tag) === -1) tags.push(definition.tag); });
  });
  tags.forEach(function (tag) { if (!customElements.get(tag)) define(tag); });
})();
`;

const noDefinitions = (layers: InstanceLayers) => layers.designSystem.length === 0 && layers.project.length === 0;

/** Adds the definitions and the runtime at the end of an artboard's body (before the bridge, which injects itself after); nothing when there are no definitions. */
export function injectInstances(html: string, layers: InstanceLayers): string {
  if (noDefinitions(layers)) return html;
  const json = JSON.stringify(layers).replace(/</g, "\\u003c");
  const tag = `<script type="application/json" id="${INSTANCES_DATA_ID}">${json}</script><script src="${INSTANCES_PATH}"></script>`;
  const end = html.lastIndexOf("</body>");
  return end === -1 ? html + tag : html.slice(0, end) + tag + html.slice(end);
}

/**
 * The definitions an artboard of `pageId` displays: a design system's own page gets its draft; a project page gets
 * its design system's definitions as of `diffusion` (the draft when undefined: the "preview=draft" request) plus the
 * project's own components.
 */
export function instanceLayersOf(store: Store, pageId: string, diffusion: number | undefined, versionId?: string): InstanceLayers {
  const page = store.getPage(pageId);
  if (!page) return { designSystem: [], project: [] };
  if (store.isDesignSystemPage(pageId)) return { designSystem: projectComponents(store, page.projectId).definitions, project: [] };
  const designSystemId = store.sharedDesignSystemIdOfPage(pageId, versionId);
  const designSystem =
    designSystemId === undefined ? [] : diffusion === undefined ? projectComponents(store, designSystemId).definitions : store.diffusionDefinitions(designSystemId, diffusion);
  return { designSystem, project: projectComponents(store, page.projectId).definitions };
}
