import type { Gap } from "@redline/shared";
import { counted } from "./plural.js";

const ON_ELEMENT: Record<string, string> = {
  button: "un bouton",
  a: "un lien",
  input: "un champ",
  select: "une liste de choix",
  textarea: "une zone de texte",
  img: "une image",
  p: "un paragraphe",
  h1: "un titre",
  h2: "un titre",
  h3: "un titre",
  h4: "un titre",
  h5: "un titre",
  h6: "un titre",
};

/** "un bouton": what a gap sits on, "un élément" for tags without a name of their own. */
export function elementPhrase(tag: string): string {
  return ON_ELEMENT[tag] ?? "un élément";
}

const CONTROL_LABEL: Record<string, string> = { "<button>": "Bouton", "<input>": "Champ", "<select>": "Liste de choix", "<textarea>": "Zone de texte" };

/** One piece of a sentence: plain text or a name shown in monospace (token, colour, component). */
export type Piece = string | { code: string; large?: boolean };

/** What the gap says, e.g. "Couleur en dur #FF6B00 sur un bouton". */
export function gapSummary(gap: Gap): Piece[] {
  switch (gap.kind) {
    case "color":
      return ["Couleur en dur ", { code: gap.value, large: true }, ...(gap.element ? [` sur ${elementPhrase(gap.element)}`] : [])];
    case "font":
      return [`Police en dur « ${gap.value} »`];
    case "control":
      return [`${CONTROL_LABEL[gap.value] ?? "Contrôle"} sans composant du design system`];
    case "deprecated":
      return ["Utilise ", { code: gap.value, large: true }];
    case "instance-style":
      return ["Style hors emplacement sur une instance : ", { code: gap.value, large: true }];
    case "instance-rule":
      return ["Règle de la page qui atteint l'intérieur d'une instance : ", { code: gap.value, large: true }];
  }
}

/** The suggestion that goes with a gap, or null. */
export function gapSuggestion(gap: Gap): Piece[] | null {
  const { token, component } = gap.suggestion ?? {};
  switch (gap.kind) {
    case "color":
      return token || component
        ? [
            ...(token ? ["Proche de ", { code: token }] : []),
            ...(component ? [token ? " · un " : "Un ", { code: component }, " existe pour ce cas"] : []),
          ]
        : null;
    case "font":
      return token ? ["Au lieu de ", { code: token }] : null;
    case "control":
      return component ? ["Un ", { code: component }, " existe pour ce cas"] : null;
    case "deprecated":
      return token ? ["Renommé en ", { code: token }, ". L'ancien nom marche encore ; il sera supprimé quand plus aucune page ne l'utilisera."] : null;
    case "instance-style":
      return ["Une instance garde l'apparence de son composant : seules sa place et sa taille se règlent dans la page, le reste passe par un réglage ou une demande de nouveau réglage."];
    case "instance-rule":
      return ["L'intérieur d'une instance vient du composant : passe par un réglage ou une demande de nouveau réglage au lieu de le restyler."];
  }
}

export const gapCountLabel = (count: number) => counted(count, "écart", "écarts");

export const exceptionCountLabel = (count: number) => counted(count, "exception voulue masquée", "exceptions voulues masquées");

const plain = (pieces: Piece[]) => pieces.map((piece) => (typeof piece === "string" ? piece : piece.code)).join("");

/** The message "Demander à Claude de corriger" posts: one line per visible gap, with its suggestion. */
export function fixGapsMessage(designSystemTitle: string, gaps: readonly Gap[]): string {
  const lines = gaps.map((gap) => {
    const suggestion = gapSuggestion(gap);
    return `- ${gap.file} : ${plain(gapSummary(gap))}${suggestion ? ` (${plain(suggestion)})` : ""}`;
  });
  return [
    `Corrige ces ${gapCountLabel(gaps.length)} au design system ${designSystemTitle} : utilise les tokens et les composants à la place des valeurs en dur.`,
    "",
    ...lines,
    "",
    "Si un écart est voulu pour une illustration ponctuelle, laisse-le et marque l'élément avec l'attribut data-ds-libre.",
  ].join("\n");
}
