// What markup writes as instances (component instances, ticket 07): the `<ui-name ...>` elements, their attributes and
// the named slots they fill. Pure, so guards (removals, defaults, rollbacks) share one reading of the markup.

import { DEFAULT_SLOT, INSTANCE_TAG_PREFIX, type ComponentDefinition, type ComponentSetting } from "./componentDefinition.js";

/** An instance written in some markup. */
export interface InstanceUse {
  /** Component name (the tag without its `ui-` prefix). */
  name: string;
  /** Attributes by lower-cased name; a boolean attribute has the value "". */
  attributes: Record<string, string>;
  /** Names of the slots its direct children fill (`slot="title"`). */
  slots: string[];
}

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTE)) attributes[name.toLowerCase()] = double ?? single ?? bare ?? "";
  return attributes;
}

/** The instances `html` writes, in document order. */
export function instanceUsesIn(html: string): InstanceUse[] {
  const uses: InstanceUse[] = [];
  const open: { tag: string; use?: InstanceUse }[] = [];
  const scanner = new RegExp(TAG);
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    const [, closing, rawTag, rest = ""] = match;
    if (rawTag === undefined) continue;
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      const at = open.map((e) => e.tag).lastIndexOf(tag);
      if (at >= 0) open.length = at;
      continue;
    }
    const attributes = attributesOf(rest);
    const parent = open[open.length - 1]?.use;
    if (parent && attributes.slot !== undefined && !parent.slots.includes(attributes.slot)) parent.slots.push(attributes.slot);
    const use: InstanceUse | undefined = tag.startsWith(INSTANCE_TAG_PREFIX) ? { name: tag.slice(INSTANCE_TAG_PREFIX.length), attributes, slots: [] } : undefined;
    if (use) uses.push(use);
    const selfClosing = rest.trimEnd().endsWith("/") || VOID_ELEMENTS.has(tag);
    if (selfClosing) continue;
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, scanner.lastIndex);
      scanner.lastIndex = end < 0 ? html.length : end;
    } else open.push({ tag, use });
  }
  return uses;
}

/** What a change of definitions takes away from one instance. */
export type InstanceBreak =
  | { kind: "component"; component: string }
  | { kind: "setting"; component: string; setting: string }
  | { kind: "value"; component: string; setting: string; value: string }
  | { kind: "slot"; component: string; slot: string };

const settingNamed = (definition: ComponentDefinition, name: string): ComponentSetting | undefined => definition.settings.find((s) => s.name === name);

/**
 * What `use` relied on in the `before` definitions that the `after` ones no longer offer: its component, a setting it
 * sets, a choice value it sets, a named slot it fills. Things `before` did not offer are not removals.
 */
export function breaksOf(use: InstanceUse, before: ComponentDefinition[], after: ComponentDefinition[]): InstanceBreak[] {
  const was = before.find((d) => d.name === use.name);
  if (!was) return [];
  const now = after.find((d) => d.name === use.name);
  if (!now) return [{ kind: "component", component: use.name }];
  const breaks: InstanceBreak[] = [];
  for (const [attribute, value] of Object.entries(use.attributes)) {
    const old = settingNamed(was, attribute);
    if (!old) continue;
    const current = settingNamed(now, attribute);
    if (!current) breaks.push({ kind: "setting", component: use.name, setting: attribute });
    else if (current.options && !current.options.includes(value) && (!old.options || old.options.includes(value))) breaks.push({ kind: "value", component: use.name, setting: attribute, value });
  }
  for (const slot of use.slots) {
    if (slot !== DEFAULT_SLOT && was.slots.includes(slot) && !now.slots.includes(slot)) breaks.push({ kind: "slot", component: use.name, slot });
  }
  return breaks;
}

/** A setting whose default value differs between two definitions of a component. */
export interface DefaultChange {
  component: string;
  setting: string;
  from: string | number | boolean | undefined;
  to: string | number | boolean | undefined;
}

export function defaultChangesOf(before: ComponentDefinition[], after: ComponentDefinition[]): DefaultChange[] {
  return before.flatMap((was) => {
    const now = after.find((d) => d.name === was.name);
    if (!now) return [];
    return was.settings.flatMap((old) => {
      const current = settingNamed(now, old.name);
      return current && current.default !== old.default ? [{ component: was.name, setting: old.name, from: old.default, to: current.default }] : [];
    });
  });
}
