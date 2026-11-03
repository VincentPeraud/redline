import type { ReviewChange, ReviewOrigin } from "@redline/shared";
import { agree, counted } from "./plural.js";

const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}` : (items[0] ?? ""));

export function originText(origin: ReviewOrigin): string {
  if (origin.kind === "direct") return "fait directement dans le design system";
  return `${origin.kind === "request" ? "demandée par" : "ton commentaire sur"} ${list(origin.from)}`;
}

const de = (title: string) => (/^[aeiouyhàâéèêëîïôû]/i.test(title) ? `d’${title}` : `de ${title}`);

/** "Toutes les pages d’App et de Site public". */
export function tokensWhereText(projects: string[]): string {
  return projects.length === 0 ? "Aucun projet n’utilise encore ce design system" : `Toutes les pages ${list(projects.map(de))}`;
}

/** "12 instances dans 6 pages de projets". */
export const whereSummary = (instances: number, pages: number): string =>
  `${counted(instances, "instance", "instances")} dans ${counted(pages, "page", "pages")} de projets`;

/** "Nulle part : App a déjà son propre ui-slot-picker et le garde". */
export function keptByText(projects: string[], name: string): string {
  const who = list(projects);
  return `Nulle part : ${who} ${agree(projects.length, "a déjà son propre", "ont déjà leur propre")} ui-${name} et ${agree(projects.length, "le garde", "le gardent")}`;
}

/** "remonté depuis App : ses 8 instances passeront à celui-ci". */
export function movedUpText(moved: { project: string; instances: number }[]): string {
  return moved
    .map(({ project, instances }) => `remonté depuis ${project} : ${agree(instances, "son instance passera", `ses ${instances} instances passeront`)} à celui-ci`)
    .join(" ; ");
}

export const componentsHeading = (count: number): string => `${counted(count, "composant", "composants")} ${agree(count, "change", "changent")}`;

/** A line of "Ce qui change": its recorded label, or the wording of a component changed with no description. */
export const changeLabel = (change: ReviewChange): string => (change.undescribed ? "Modification sans description" : change.label);
