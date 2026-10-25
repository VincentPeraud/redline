import type { Gap } from "@redline/shared";

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
  }
}

export const gapCountLabel = (count: number) => `${count} ${count === 1 ? "écart" : "écarts"}`;
