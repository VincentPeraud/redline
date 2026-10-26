const REFUSALS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^"(.*)" already has a file named (.*)$/, ([, page, file]) => `« ${page} » a déjà un fichier nommé ${file}.`],
  [/^A session is working on "(.*)": try again once it is done\.$/, ([, page]) => `Une session travaille sur « ${page} » : réessaie quand elle aura fini.`],
  [/^an artboard can only move to a page of the same project$/, () => "Un artboard ne peut aller que sur une page du même projet."],
  [/^the artboard already is on that page$/, () => "L'artboard est déjà sur cette page."],
  [/^(.*) is not an artboard of "(.*)"$/, ([, file, page]) => `${file} n'est pas un artboard de « ${page} ».`],
  [/^(target )?page not found$/, () => "Cette page n'existe plus."],
  [/^title is required$/, () => "Le titre de la page est obligatoire."],
  [/^title must be at most (\d+) characters$/, ([, max]) => `Le titre de la page ne peut pas dépasser ${max} caractères.`],
];

/** The server's English reason a move (or another change of the page's artboards) was refused, in French for the dialog. */
export function moveRefusalMessage(error: string, fallback = "Le déplacement a été refusé."): string {
  for (const [pattern, french] of REFUSALS) {
    const match = pattern.exec(error);
    if (match) return french(match);
  }
  return fallback;
}
