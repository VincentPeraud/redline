import type { BrokenElement, BrokenPlace } from "@redline/shared";
import { counted } from "./plural.js";
import type { Piece } from "./gapLabels.js";

/** Which way the project switches: onto the draft (the draft removed what pages use) or back to the latest diffusion (the diffusion lacks it). */
export type FollowDirection = "draft" | "diffusion";

const BLOCKS_ON = "la page ne pourra plus être publiée tant qu'elle l'utilise";
const BLOCKS_OFF = "la page ne pourra plus être publiée tant qu'il n'est pas diffusé";
const RENDERS_WITHOUT = "s'affiche sans elle";

/** One broken element of a page as the dialog words it: plain text and names shown in monospace. */
export function brokenElementPieces(element: BrokenElement, direction: FollowDirection): Piece[] {
  const back = direction === "diffusion";
  const blocks = back ? BLOCKS_OFF : BLOCKS_ON;
  const gone = back ? "absent" : "retiré du brouillon";
  switch (element.kind) {
    case "component":
      return [{ code: element.name }, ` · composant ${gone} : ${blocks}`];
    case "setting":
      return [{ code: element.name }, ` · réglage « ${element.setting} » ${gone} : ${blocks}`];
    case "value":
      return back
        ? [{ code: element.name }, " · réglage ", { code: `${element.setting}="${element.value}"` }, ` absent : ${blocks}`]
        : [{ code: `${element.name} ${element.setting}="${element.value}"` }, ` · valeur retirée du brouillon : ${blocks}`];
    case "slot":
      return [{ code: element.name }, ` · emplacement « ${element.slot} » ${gone} : ${blocks}`];
    case "token":
      return [{ code: element.name }, " · ", ...(element.renamedTo ? ["variable renommée en ", { code: element.renamedTo }] : [back ? "variable absente" : "variable retirée du brouillon"]), ` : ${RENDERS_WITHOUT}`];
  }
}

/** "Connexion, Compte créé · 4 instances": where the element is, with its instances counted once. */
export function placesText(places: BrokenPlace[]): string {
  const instances = places.reduce((sum, place) => sum + (place.instances ?? 0), 0);
  const where = places.map((place) => place.artboard).join(", ");
  return places.some((place) => place.instances !== undefined) ? `${where} · ${counted(instances, "instance", "instances")}` : where;
}

/** "A, B et C". */
const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} et ${names.at(-1)}`);

/** "A et B", "A et 2 autres projets": the other projects that receive a diffusion; `hidden` counts the ones the viewer may not read. */
export function otherProjectsText(names: string[], hidden: number): string {
  if (hidden === 0) return listed(names);
  const rest = `${hidden} ${hidden === 1 ? "autre projet" : "autres projets"}`;
  return names.length === 0 ? rest : `${names.join(", ")} et ${rest}`;
}
