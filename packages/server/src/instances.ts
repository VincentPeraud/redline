import { INSTANCE_TAG_PREFIX, instanceTagOf, type InstanceLayers } from "@redline/shared";
import { projectComponents } from "./components.js";
import { excludedComponents } from "./switch-design-system.js";
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
 *   - a change to a setting attribute renders again, except the state attributes `open` and `selected`, which only the
 *     component's script reacts to (rendering again would drop what the script set up);
 *   - the component's behaviour script runs once per instance after its first render, as the body of a function that
 *     receives the instance as `host` (it reacts to attributes such as `open` and dispatches events);
 *   - a click on an element with `opens`, `closes` or `toggles` set to an instance id sets, removes or toggles that
 *     instance's `open` attribute (the component's script may handle it its own way);
 *   - a tag written in the page resolves to the project's definition, then the design system's; a tag inside a design
 *     system template resolves to the design system's definition only. Nesting stops at MAX_DEPTH.
 *
 * Plain ES2015 (custom elements need `class`); it only runs in browsers that have them.
 */
export const INSTANCES_PATH = "/__redline/instances.js";

export const INSTANCES_DATA_ID = "redline-components";

export const INSTANCES_SOURCE = `(function () {
  var MAX_DEPTH = 10;
  var STATE_ATTRIBUTES = ["open", "selected"];
  var SCOPE_PAGE = "page";
  var SCOPE_DESIGN_SYSTEM = "designSystem";
  var data = document.getElementById("${INSTANCES_DATA_ID}");
  if (!data || typeof customElements === "undefined") return;
  var layers = JSON.parse(data.textContent || "{}");
  var designSystemScoped = new WeakSet();
  var tags = [];

  function definitionIn(list, tag) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].tag === tag) return list[i];
    return null;
  }

  // A tag a design system switch left out, written in a page that has no project component of that name: broken whatever the design system has.
  function leftOutFrom(tag, scope) {
    if (scope !== SCOPE_PAGE || definitionIn(layers.project, tag)) return null;
    var list = layers.excluded || [];
    for (var i = 0; i < list.length; i++) if (list[i].tag === tag) return list[i];
    return null;
  }

  // Returns { definition, scope } where scope is the one the definition's own template tags resolve with.
  function resolve(tag, scope) {
    if (leftOutFrom(tag, scope) !== null) return null;
    if (scope === SCOPE_PAGE) {
      var own = definitionIn(layers.project, tag);
      if (own) return { definition: own, scope: SCOPE_PAGE };
    }
    var shared = definitionIn(layers.designSystem, tag);
    return shared ? { definition: shared, scope: SCOPE_DESIGN_SYSTEM } : null;
  }

  // Broken instances go through the errors catcher (bridge.ts), which lists them in "Erreurs des artboards".
  function report(message) {
    if (window.__redlineErrors) window.__redlineErrors.add(message);
  }

  // A choice whose value is not among the options takes the default; returns true when it changed the attribute.
  function fixUnknownValues(host, tag, definition) {
    var fixed = false;
    definition.settings.forEach(function (setting) {
      if (setting.type === "toggle" || !setting.options || !host.hasAttribute(setting.name)) return;
      var value = host.getAttribute(setting.name);
      if (setting.options.indexOf(value) !== -1) return;
      var fallback = setting.default === undefined ? setting.options[0] : String(setting.default);
      var since = layers.diffusion === undefined ? "" : " depuis la diffusion " + layers.diffusion;
      report(tag + " : la valeur " + value + " du réglage " + setting.name + " n'existe plus" + since + ". Affichée avec la valeur par défaut (" + fallback + ").");
      host.setAttribute(setting.name, fallback);
      fixed = true;
    });
    return fixed;
  }

  // A tag no layer defines, or one a design system switch left out: a placeholder naming it, and an error.
  function markUnknown(root) {
    Array.prototype.slice.call(root.querySelectorAll("*")).forEach(function (element) {
      var tag = element.localName;
      if (tag.indexOf("${INSTANCE_TAG_PREFIX}") !== 0 || element.hasAttribute("data-redline-unknown")) return;
      var left = leftOutFrom(tag, designSystemScoped.has(element) ? SCOPE_DESIGN_SYSTEM : SCOPE_PAGE);
      if (left === null && tags.indexOf(tag) !== -1) return;
      var message = left === null ? tag + " : composant introuvable" : tag + (left.available ? " non repris de " : " absent de ") + left.from;
      element.setAttribute("data-redline-unknown", "");
      var placeholder = document.createElement("span");
      placeholder.setAttribute("data-redline-missing", "");
      placeholder.setAttribute("style", "display:inline-block;padding:2px 6px;border:1px dashed #F5C2BC;border-radius:4px;background:#FEF3F2;color:#B42318;font:12px/1.4 monospace");
      placeholder.textContent = message;
      element.insertBefore(placeholder, element.firstChild);
      report(message);
    });
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
    var slots = Array.prototype.slice.call(fragment.querySelectorAll("slot"));
    var slotNames = slots.map(function (slot) { return slot.getAttribute("name") || ""; });
    Object.keys(bySlot).forEach(function (name) {
      if (slotNames.indexOf(name) === -1 && hasContent(bySlot[name])) report(host.localName + " : l'emplacement " + (name || "par défaut") + " n'existe plus. Son contenu n'est pas affiché.");
    });
    slots.forEach(function (slot) {
      var nodes = bySlot[slot.getAttribute("name") || ""];
      slot.replaceWith.apply(slot, nodes && hasContent(nodes) ? nodes : Array.prototype.slice.call(slot.childNodes));
    });
    if (resolved.scope === SCOPE_DESIGN_SYSTEM) {
      Array.prototype.slice.call(fragment.querySelectorAll("*")).forEach(function (element) {
        if (element.localName.indexOf("ui-") === 0) designSystemScoped.add(element);
      });
    }
    markUnknown(fragment);
    host.replaceChildren(fragment);
  }

  function define(tag) {
    var observed = [];
    [layers.project, layers.designSystem].forEach(function (list) {
      var definition = definitionIn(list, tag);
      if (definition) definition.settings.forEach(function (setting) { if (STATE_ATTRIBUTES.indexOf(setting.name) === -1 && observed.indexOf(setting.name) === -1) observed.push(setting.name); });
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
        fixUnknownValues(this, tag, resolved.definition);
        render(this, resolved);
        this.__rendered = true;
        if (resolved.definition.script) new Function("host", resolved.definition.script)(this);
      }
      attributeChangedCallback() {
        if (!this.__rendered || fixUnknownValues(this, tag, this.__redlineInstance.definition)) return;
        render(this, this.__redlineInstance);
      }
    });
  }

  var WIRING = [["opens", "set"], ["closes", "remove"], ["toggles", "toggle"]];
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    WIRING.forEach(function (wiring) {
      var source = target.closest("[" + wiring[0] + "]");
      var instance = source && document.getElementById(source.getAttribute(wiring[0]));
      if (!instance) return;
      if (wiring[1] === "set") instance.setAttribute("open", "");
      else if (wiring[1] === "remove") instance.removeAttribute("open");
      else instance.toggleAttribute("open");
    });
  });


  [layers.project, layers.designSystem].forEach(function (list) {
    (list || []).forEach(function (definition) { if (tags.indexOf(definition.tag) === -1) tags.push(definition.tag); });
  });
  tags.forEach(function (tag) { if (!customElements.get(tag)) define(tag); });
  markUnknown(document);
})();
`;

const noDefinitions = (layers: InstanceLayers) => layers.designSystem.length === 0 && layers.project.length === 0 && !layers.excluded?.length;

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
  if (store.isDesignSystemPage(pageId)) return { designSystem: diffusion === undefined ? projectComponents(store, page.projectId).definitions : store.diffusionDefinitions(page.projectId, diffusion), project: [] };
  const designSystemId = store.sharedDesignSystemIdOfPage(pageId, versionId);
  const designSystem =
    designSystemId === undefined ? [] : diffusion === undefined ? projectComponents(store, designSystemId).definitions : store.diffusionDefinitions(designSystemId, diffusion);
  const from = designSystemId === undefined ? undefined : store.getDesignSystem(designSystemId)?.title;
  const excluded = designSystemId === undefined ? [] : excludedComponents(store, page.projectId, designSystemId).map(({ tag, from, available }) => ({ tag, from, available }));
  return { designSystem, project: projectComponents(store, page.projectId).definitions, ...(excluded.length > 0 && { excluded }), ...(diffusion !== undefined && { diffusion }) };
}
