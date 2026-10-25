// Gaps (lot E, ticket 21). A gap is an element of an artboard that bypasses the design system; this pure module
// finds them in an artboard's HTML and CSS against the tokens and components available to its page.

import type { TokenDeclaration } from "./tokens.js";

export const GAP_KINDS = ["color", "font", "control", "deprecated"] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** The marker that takes an element and its descendants out of the analysis. */
export const DS_FREE_ATTRIBUTE = "data-ds-libre";

export interface Gap {
  /** Stable across analyses: same artboard, kind, value and place give the same key. */
  key: string;
  file: string;
  kind: GapKind;
  /** The hard-coded colour as written, the font family, `<button>`, or the deprecated token name. */
  value: string;
  /** Tag name of the element concerned, null when a stylesheet selector matches no element. */
  element: string | null;
  /** Path of the element in the artboard's DOM, in the format of the bridge's selectors; null without an element. */
  selector: string | null;
  suggestion?: {
    /** Closest colour token, token to use for the font, or the token a deprecated one was renamed to. */
    token?: string;
    /** Component meant for this case. */
    component?: string;
  };
}

export interface GapContext {
  /** Tokens in force for the page: the design system's current diffusion with the project style's over them. */
  tokens: TokenDeclaration[];
  /** Components of the design system's current diffusion and of the project, with the classes they define. */
  components: { name: string; classes: string[] }[];
}

interface Node {
  tag: string;
  attrs: Record<string, string>;
  parent: Node | null;
  children: Node[];
  /** Text of a `<style>` element. */
  text: string;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const HEAD_TAGS = new Set(["meta", "link", "title", "style", "script", "base"]);
const SELF_CLOSING_SIBLINGS = new Set(["li", "option", "dt", "dd", "tr", "td", "th", "p"]);

const TOKEN_PATTERN = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const newNode = (tag: string, parent: Node | null, attrs: Record<string, string> = {}): Node => ({ tag, attrs, parent, children: [], text: "" });

/** A tolerant parse of an HTML document into the tree a browser would build (html, head and body always present). */
function parseHtml(html: string): Node {
  const root = newNode("#root", null);
  const htmlNode = newNode("html", root);
  const head = newNode("head", htmlNode);
  const body = newNode("body", htmlNode);
  root.children.push(htmlNode);
  htmlNode.children.push(head, body);
  let seenBody = false;
  let stack: Node[] = [htmlNode];
  const top = () => stack[stack.length - 1];
  const append = (node: Node) => {
    node.parent!.children.push(node);
  };

  TOKEN_PATTERN.lastIndex = 0;
  for (let match = TOKEN_PATTERN.exec(html); match; match = TOKEN_PATTERN.exec(html)) {
    const [, closing, opening, rawAttrs = ""] = match;
    if (closing) {
      const tag = closing.toLowerCase();
      if (tag === "body" || tag === "html" || tag === "head") {
        stack = [htmlNode];
        if (tag === "head") seenBody = false;
        continue;
      }
      const index = stack.map((n) => n.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (!opening) continue;
    const tag = opening.toLowerCase();
    const attrs: Record<string, string> = {};
    for (const [, name, double, single, bare] of rawAttrs.matchAll(ATTRIBUTE_PATTERN)) attrs[name.toLowerCase()] = double ?? single ?? bare ?? "";
    if (tag === "html") continue;
    if (tag === "head") {
      stack = [htmlNode, head];
      continue;
    }
    if (tag === "body") {
      Object.assign(body.attrs, attrs);
      stack = [htmlNode, body];
      seenBody = true;
      continue;
    }
    if (top() === htmlNode) {
      if (!seenBody && HEAD_TAGS.has(tag)) stack.push(head);
      else {
        stack.push(body);
        seenBody = true;
      }
    }
    if (SELF_CLOSING_SIBLINGS.has(tag) && top().tag === tag) stack.pop();
    const node = newNode(tag, top(), attrs);
    append(node);
    if (RAW_TEXT.has(tag)) {
      const end = new RegExp(`</${tag}\\s*>`, "gi");
      end.lastIndex = TOKEN_PATTERN.lastIndex;
      const closed = end.exec(html);
      node.text = html.slice(TOKEN_PATTERN.lastIndex, closed ? closed.index : html.length);
      TOKEN_PATTERN.lastIndex = closed ? closed.index + closed[0].length : html.length;
    } else if (!VOID.has(tag) && !match[0].endsWith("/>")) stack.push(node);
  }
  return root;
}

function* elementsOf(node: Node): Generator<Node> {
  for (const child of node.children) {
    yield child;
    yield* elementsOf(child);
  }
}

const escapeIdent = (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`);

/** Selector of an element in the bridge's format: the nearest id, else tag names with `:nth-of-type` among same-tag siblings. */
function selectorOf(node: Node): string {
  const parts: string[] = [];
  for (let el: Node | null = node; el && el.tag !== "html"; el = el.parent) {
    if (el.attrs.id) {
      parts.unshift(`#${escapeIdent(el.attrs.id)}`);
      break;
    }
    const same = el.parent!.children.filter((c) => c.tag === el!.tag);
    parts.unshift(same.length > 1 ? `${el.tag}:nth-of-type(${same.indexOf(el) + 1})` : el.tag);
  }
  return parts.join(" > ");
}

const isFree = (node: Node): boolean => {
  for (let el: Node | null = node; el; el = el.parent) if (DS_FREE_ATTRIBUTE in el.attrs) return true;
  return false;
};

const classesOfNode = (node: Node) => (node.attrs.class ?? "").split(/\s+/).filter(Boolean);

// --- CSS ---

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `text` with every balanced `name(...)` call removed, for the function names given (all functions when none). */
function withoutCalls(text: string, names?: string[]): string {
  let result = "";
  for (let i = 0; i < text.length; ) {
    const call = /^([A-Za-z-]+)\(/.exec(text.slice(i));
    if (call && (!names || names.includes(call[1].toLowerCase()))) {
      let depth = 0;
      let j = i + call[1].length;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      i = j + 1;
    } else result += text[i++];
  }
  return result;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

interface Declaration {
  property: string;
  value: string;
}

function declarationsOf(block: string): Declaration[] {
  const result: Declaration[] = [];
  for (const part of splitTopLevel(stripComments(block), ";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).replace(/!important\s*$/i, "").trim();
    if (property && value) result.push({ property, value });
  }
  return result;
}

interface Rule {
  selector: string;
  declarations: Declaration[];
}

const NESTING_AT_RULES = /^@(media|supports|layer|container|document)\b/i;

function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const text = stripComments(css);
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    const prelude = text.slice(i, open).trim();
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith("@")) {
      if (NESTING_AT_RULES.test(prelude)) rules.push(...rulesOf(body));
    } else rules.push({ selector: prelude, declarations: declarationsOf(body) });
    i = j;
  }
  return rules;
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
}

/** The selector as compounds with their combinator to the previous one, or null when it uses more than tag, id, class, descendant and child. */
function parseSelector(selector: string): { combinator: " " | ">"; compound: Compound }[] | null {
  const plain = selector.replace(/::?[\w-]+(\([^)]*\))?/g, "").replace(/\s*>\s*/g, " > ").trim();
  if (plain === "" || /[^\w\-#.*>\s]/.test(plain)) return null;
  const result: { combinator: " " | ">"; compound: Compound }[] = [];
  let combinator: " " | ">" = " ";
  for (const word of plain.split(/\s+/)) {
    if (word === ">") {
      combinator = ">";
      continue;
    }
    const compound: Compound = { tag: null, id: null, classes: [] };
    for (const [, prefix, name] of word.matchAll(/([#.]?)([\w-]+|\*)/g)) {
      if (prefix === "#") compound.id = name;
      else if (prefix === ".") compound.classes.push(name);
      else if (name !== "*") compound.tag = name.toLowerCase();
    }
    result.push({ combinator, compound });
    combinator = " ";
  }
  return result;
}

const matchesCompound = (node: Node, c: Compound) =>
  (c.tag === null || node.tag === c.tag) && (c.id === null || node.attrs.id === c.id) && c.classes.every((name) => classesOfNode(node).includes(name));

function matchesChain(node: Node, chain: { combinator: " " | ">"; compound: Compound }[], index: number): boolean {
  if (!matchesCompound(node, chain[index].compound)) return false;
  if (index === 0) return true;
  if (chain[index].combinator === ">") return node.parent !== null && matchesChain(node.parent, chain, index - 1);
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) if (matchesChain(ancestor, chain, index - 1)) return true;
  return false;
}

function matchingElements(root: Node, selector: string): Node[] {
  const chains = splitTopLevel(selector, ",").map((part) => parseSelector(part.trim()));
  return [...elementsOf(root)].filter((node) => chains.some((chain) => chain !== null && matchesChain(node, chain, chain.length - 1)));
}

// --- Colours ---

function rgbOf(value: string): [number, number, number] | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(text)?.[1];
  if (fn) {
    const numbers = fn.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((part) => (part.endsWith("%") ? (parseFloat(part) * 255) / 100 : parseFloat(part)));
    if (numbers.length === 3 && numbers.every(Number.isFinite)) return numbers as [number, number, number];
  }
  return null;
}

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

/** Hard-coded colours of a declaration value, ignoring anything inside `var()` (fallbacks), `url()` and strings. */
function hardCodedColors(value: string): string[] {
  const stripped = withoutCalls(value, ["var", "url"]).replace(/"[^"]*"|'[^']*'/g, "");
  return [...stripped.matchAll(COLOR_PATTERN)].map((m) => m[0]).filter((c) => rgbOf(c) !== null);
}

function closestColorToken(color: string, tokens: TokenDeclaration[]): string | undefined {
  const target = rgbOf(color);
  if (!target) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const token of tokens) {
    if (!token.isColor || token.deprecatedFor) continue;
    const rgb = rgbOf(token.value);
    if (!rgb) continue;
    const distance = rgb.reduce((sum, channel, i) => sum + (channel - target[i]) ** 2, 0);
    if (!best || distance < best.distance) best = { name: token.name, distance };
  }
  return best?.name;
}

// --- Fonts, controls ---

const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/** First family of a `font-family` value written without any `var()`, null when the value is a keyword or goes through a token. */
function hardCodedFont(value: string): string | null {
  if (/var\(/i.test(value)) return null;
  const first = splitTopLevel(value, ",")[0].trim().replace(/^["']|["']$/g, "");
  return first === "" || CSS_WIDE.has(first.toLowerCase()) ? null : first;
}

const CONTROL_COMPONENT_NAMES: Record<string, RegExp> = {
  button: /button|btn|cta/,
  input: /input|field|text/,
  select: /select|dropdown|picker/,
  textarea: /textarea|text-?area|field|input/,
};

const isControl = (node: Node) => node.tag in CONTROL_COMPONENT_NAMES && !(node.tag === "input" && node.attrs.type?.toLowerCase() === "hidden");

// --- Analysis ---

/** The gaps of one artboard, in document order (inline styles first, then stylesheets). */
export function analyseGaps(file: string, html: string, context: GapContext): Gap[] {
  const root = parseHtml(html);
  const deprecated = new Map(context.tokens.filter((t) => t.deprecatedFor).map((t) => [t.name, t.deprecatedFor!]));
  const componentClasses = new Set(context.components.flatMap((c) => c.classes));
  const gaps = new Map<string, Gap>();

  const add = (kind: GapKind, value: string, node: Node | null, where: string, suggestion?: Gap["suggestion"]) => {
    const selector = node ? selectorOf(node) : null;
    const key = JSON.stringify([file, kind, value, selector ?? where]);
    if (!gaps.has(key)) gaps.set(key, { key, file, kind, value, element: node?.tag ?? null, selector, ...(suggestion && Object.keys(suggestion).length ? { suggestion } : {}) });
  };

  const componentFor = (node: Node | null): string | undefined => {
    if (!node || !isControl(node) || classesOfNode(node).some((c) => componentClasses.has(c))) return undefined;
    return context.components.find((c) => CONTROL_COMPONENT_NAMES[node.tag].test(c.name))?.name;
  };

  const check = (declarations: Declaration[], node: Node | null, where: string) => {
    for (const { property, value } of declarations) {
      if (!property.startsWith("--")) {
        for (const color of hardCodedColors(value)) {
          const token = closestColorToken(color, context.tokens);
          const component = componentFor(node);
          add("color", color, node, where, { ...(token ? { token } : {}), ...(component ? { component } : {}) });
        }
        if (property === "font-family") {
          const family = hardCodedFont(value);
          if (family !== null) {
            const wanted = node && /^h[1-6]$/.test(node.tag) ? "--font-heading" : "--font-body";
            add("font", family, node, where, context.tokens.some((t) => t.name === wanted) ? { token: wanted } : undefined);
          }
        }
      }
      for (const [, name] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (deprecated.has(name)) add("deprecated", name, node, where, { token: deprecated.get(name) });
      }
    }
  };

  for (const node of elementsOf(root)) {
    if (isFree(node)) continue;
    if (node.attrs.style) check(declarationsOf(node.attrs.style), node, "style");
    if (isControl(node)) {
      const component = componentFor(node);
      if (component) add("control", `<${node.tag}>`, node, "control", { component });
    }
  }

  for (const sheet of [...elementsOf(root)].filter((n) => n.tag === "style")) {
    for (const rule of rulesOf(sheet.text)) {
      const matched = matchingElements(root, rule.selector);
      const target = matched.find((n) => !isFree(n)) ?? null;
      if (matched.length > 0 && target === null) continue;
      check(rule.declarations, target, `css:${rule.selector}`);
    }
  }
  return [...gaps.values()];
}

/** `GET /api/pages/:id/gaps`: the gaps of the latest version, and the title of the design system they are measured against. */
export interface PageGaps {
  designSystemTitle: string;
  gaps: Gap[];
}

export const pageGapsPath = (pageId: string) => `/api/pages/${pageId}/gaps`;
