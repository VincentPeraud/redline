// Component definitions (component instances, ticket 01). A definition is what an instance needs to render: the
// component's template, its slots, its settings and its behaviour script. The assembly produces one per component,
// diffusions snapshot them, and the instance runtime of each artboard turns them into custom elements.

import type { ManifestTweak, TweakType } from "./index.js";

/** Prefix of every instance tag, design system component or project component alike. */
export const INSTANCE_TAG_PREFIX = "ui-";

/** The slot name of the default slot. */
export const DEFAULT_SLOT = "";

/** A setting of a component: one tweak of its artboard, written as an attribute of the instance. */
export interface ComponentSetting {
  /** Attribute name (the tweak id, lower-cased as HTML does). */
  name: string;
  type: TweakType;
  /** `choice` only: the values the attribute may take. */
  options?: string[];
  /** Value an omitted attribute takes; a toggle's default is `false` when the tweak gives none. */
  default?: string | number | boolean;
}

export interface ComponentDefinition {
  /** Component name (its file name). */
  name: string;
  /** `ui-<name>`. */
  tag: string;
  /** Markup an instance renders, with `<slot>` elements. */
  template: string;
  /** Slot names the template offers, `DEFAULT_SLOT` for the default one. */
  slots: string[];
  settings: ComponentSetting[];
  /** Body of the `<script data-component>`, run per instance. */
  script?: string;
  /** Names of the components whose tags the template uses. */
  contains: string[];
}

/**
 * The definitions an artboard knows, by origin. A tag written in the page resolves to the project's definition first;
 * a tag inside a design system template resolves to the design system's only.
 */
export interface InstanceLayers {
  designSystem: ComponentDefinition[];
  project: ComponentDefinition[];
  /** Tags a design system switch left out: written in a page, they render broken even if a definition exists. */
  excluded?: ExcludedInstance[];
}

export interface ExcludedInstance {
  tag: string;
  /** Title of the design system the component was not taken from. */
  from: string;
}

export const instanceTagOf = (name: string) => `${INSTANCE_TAG_PREFIX}${name}`;

const TEMPLATE_BLOCK = /<template\b[^>]*\bdata-component\b[^>]*>([\s\S]*?)<\/template>/i;
const SCRIPT_BLOCK = /<script\b[^>]*\bdata-component\b[^>]*>([\s\S]*?)<\/script>/i;

function slotsOf(template: string): string[] {
  const slots: string[] = [];
  for (const [, attributes] of template.matchAll(/<slot\b([^>]*)>/gi)) {
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    const slot = name ? (name[1] ?? name[2] ?? DEFAULT_SLOT) : DEFAULT_SLOT;
    if (!slots.includes(slot)) slots.push(slot);
  }
  return slots;
}

function containedOf(template: string): string[] {
  const names: string[] = [];
  for (const [, name] of template.matchAll(new RegExp(`<${INSTANCE_TAG_PREFIX}([a-z0-9-]+)`, "gi"))) {
    const lower = name.toLowerCase();
    if (!names.includes(lower)) names.push(lower);
  }
  return names;
}

function settingOf(tweak: ManifestTweak): ComponentSetting {
  const setting: ComponentSetting = { name: tweak.id.toLowerCase(), type: tweak.type };
  if (tweak.type === "choice" && tweak.options) setting.options = tweak.options;
  const fallback = tweak.type === "toggle" ? false : tweak.type === "choice" ? tweak.options?.[0] : undefined;
  const value = tweak.default ?? fallback;
  if (value !== undefined) setting.default = value;
  return setting;
}

/** The definition of a component from its file and the tweaks of its artboard; null when the file has no `<template data-component>`. */
export function componentDefinitionOf(name: string, html: string, tweaks: ManifestTweak[]): ComponentDefinition | null {
  const template = TEMPLATE_BLOCK.exec(html)?.[1].trim();
  if (template === undefined) return null;
  const script = SCRIPT_BLOCK.exec(html)?.[1].trim();
  return {
    name,
    tag: instanceTagOf(name),
    template,
    slots: slotsOf(template),
    settings: tweaks.map(settingOf),
    ...(script && { script }),
    contains: containedOf(template),
  };
}
