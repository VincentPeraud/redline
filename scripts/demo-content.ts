// File contents of the demo data: design systems and page artboards. All colours come from design-system tokens.

export function tokensCss(primary: string, onPrimary = "#ffffff", background = "#ffffff", surface = "#f6f5f2"): string {
  return `:root {
  --color-primary: ${primary};
  --color-on-primary: ${onPrimary};
  --color-background: ${background};
  --color-surface: ${surface};
  --color-text: #18181b;
  --color-text-muted: #5f5f68;
  --color-border: #e4e2dc;
  --font-heading: "Inter", system-ui, sans-serif;
  --font-body: "Inter", system-ui, sans-serif;
  --radius: 10px;
  --space-unit: 8px;
}
`;
}

export function designSystemFiles(primary: string): Record<string, string> {
  return {
    "tokens.css": tokensCss(primary),
    "manifest.json": JSON.stringify({ title: "Tokens et composants", artboards: [{ file: "components.html", title: "Composants", width: 640, height: 360 }] }),
    "components.html": screen(
      "Composants",
      `<main style="padding:32px;display:flex;flex-direction:column;gap:20px">
  <h1>Composants</h1>
  <button class="cta" style="align-self:flex-start">Bouton principal</button>
  <div class="card"><strong>Carte</strong><p class="muted">Surface, bordure et rayon du design system.</p></div>
</main>`,
    ),
  };
}

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:var(--font-body);background:var(--color-background);color:var(--color-text)}
h1{margin:0;font-family:var(--font-heading);font-size:26px;line-height:1.2}
p{margin:0;line-height:1.5}
.muted{color:var(--color-text-muted);font-size:14px}
.cta{height:48px;padding:0 20px;border:none;border-radius:var(--radius);background:var(--color-primary);color:var(--color-on-primary);font:600 16px var(--font-body);cursor:pointer}
.card{padding:16px;border:1px solid var(--color-border);border-radius:var(--radius);background:var(--color-surface)}
.search{height:44px;padding:0 14px;border:1px solid var(--color-border);border-radius:var(--radius);background:var(--color-background);font:15px var(--font-body);width:100%}
.row{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid var(--color-border);border-radius:var(--radius)}
.dot{width:18px;height:18px;border-radius:50%;border:2px solid var(--color-border)}
.dot.on{border-color:var(--color-primary);background:var(--color-primary)}
.dark{background:#1c1c20;color:#fff}
`;

function screen(title: string, body: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${BASE_CSS}${extraCss}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

interface ArtboardSpec {
  file: string;
  title: string;
  width: number;
  height: number;
  html: string;
}

export interface PageSpec {
  title: string;
  files: Record<string, string>;
}

function page(title: string, artboards: ArtboardSpec[], extra: Record<string, unknown> = {}, designSystem?: string): PageSpec {
  let x = 0;
  const manifestArtboards = artboards.map((a) => {
    const entry = { file: a.file, title: a.title, width: a.width, height: a.height, x, y: 0 };
    x += a.width + 80;
    return entry;
  });
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify({ title, ...(designSystem ? { designSystem } : {}), artboards: manifestArtboards, notes: [], links: [], tweaks: [], ...extra }, null, 2),
  };
  for (const a of artboards) files[a.file] = a.html;
  return { title, files };
}

const PHONE = { width: 390, height: 760 };

/** Onboarding screens follow the page's tweaks: accent colour everywhere, list or grid for the choices. */
const ONBOARDING_TWEAK_CSS = `
.choices{display:flex;flex-direction:column;gap:10px}
.choices .row{border-color:#D4D2CC;height:52px;padding:0 16px;border-radius:12px;font-size:16px}
.choices .row.on{border:2px solid var(--tweak-accent,var(--color-primary))}
.choices .dot{width:18px;height:18px;background:#fff}
.choices .dot.on{border:5px solid var(--tweak-accent,var(--color-primary))}
.cta{height:54px;border-radius:12px}
.search{border-color:#D4D2CC;height:46px;border-radius:12px}
.cta{background:var(--tweak-accent,var(--color-primary))}
.dot.on{border-color:var(--tweak-accent,var(--color-primary));background:var(--tweak-accent,var(--color-primary))}
html[data-tweak-layout="Grille + icônes"] .choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
html[data-tweak-layout="Grille + icônes"] .choices .row{flex-direction:column;justify-content:center;height:96px;text-align:center}
`;

export function onboardingPage(designSystem: string): PageSpec {
  const welcome = screen(
    "Bienvenue",
    `<main style="padding:72px 28px 32px;display:flex;flex-direction:column;gap:20px;min-height:760px">
  <p class="muted">Étape 1 sur 3</p>
  <h1>Bienvenue sur Lumora</h1>
  <p class="muted">Trouve un professionnel de santé disponible près de chez toi, et prends rendez-vous en deux minutes.</p>
  <div style="flex-grow:1"></div>
  <button class="cta">Commencer</button>
</main>`,
    ONBOARDING_TWEAK_CSS,
  );
  const speciality = screen(
    "Spécialité",
    `<main style="padding:56px 28px 32px;display:flex;flex-direction:column;gap:14px;min-height:760px">
  <h1 style="font-size:28px">Votre spécialité</h1>
  <p class="muted" style="font-size:15px">Pour vous proposer les bons remplacements.</p>
  <input class="search" type="search" placeholder="Rechercher une spécialité" aria-label="Rechercher une spécialité">
  <div class="choices">
    <div class="row on"><span class="dot on"></span><strong>Médecin généraliste</strong></div>
    <div class="row"><span class="dot"></span>Kinésithérapeute</div>
    <div class="row"><span class="dot"></span>Infirmier·e</div>
    <div class="row"><span class="dot"></span>Sage-femme</div>
  </div>
  <div style="flex-grow:1"></div>
  <button class="cta">Continuer</button>
</main>`,
    ONBOARDING_TWEAK_CSS,
  );
  const calendar = screen(
    "Calendrier",
    `<main style="padding:56px 24px 32px;display:flex;flex-direction:column;gap:16px;min-height:760px">
  <p class="muted">Étape 3 sur 3</p>
  <h1>Choisis un créneau</h1>
  <div class="card" style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;text-align:center;font-size:14px">
    <span class="muted">D</span><span class="muted">L</span><span class="muted">M</span><span class="muted">M</span><span class="muted">J</span><span class="muted">V</span><span class="muted">S</span>
    <span>1</span><span>2</span><span>3</span><span style="color:var(--color-primary);font-weight:600">4</span><span>5</span><span>6</span><span>7</span>
  </div>
  <div class="row">Mardi 4, 09:30</div>
  <div class="row">Mardi 4, 11:00</div>
  <div style="flex-grow:1"></div>
  <button class="cta">Confirmer</button>
</main>`,
    ONBOARDING_TWEAK_CSS,
  );
  return page(
    "Onboarding",
    [
      { file: "screen-1.html", title: "1. Bienvenue", ...PHONE, html: welcome },
      { file: "screen-2.html", title: "2. Spécialité", ...PHONE, html: speciality },
      { file: "screen-3.html", title: "3. Calendrier", ...PHONE, html: calendar },
    ],
    {
      notes: [{ text: "Parcours en 3 artboards, pensé pour le téléphone.", x: 0, y: 820 }],
      links: [
        { from: "screen-1.html", selector: ".cta", to: "screen-2.html" },
        { from: "screen-2.html", selector: ".cta", to: "screen-3.html" },
      ],
      tweaks: [
        { id: "accent", type: "color", scope: "element", label: "Couleur principale", options: ["#D92D20", "#0F766E", "#7C3AED", "#18181B"], default: "#D92D20" },
        { id: "layout", type: "choice", scope: "artboard", display: "buttons", label: "Présentation des spécialités", options: ["Liste", "Grille + icônes"], default: "Liste" },
      ],
    },
    designSystem,
  );
}

function simpleDesktopPage(title: string, heading: string, text: string, designSystem?: string): PageSpec {
  const html = screen(
    title,
    `<main style="padding:64px 72px;display:flex;flex-direction:column;gap:20px;max-width:900px">
  <h1 style="font-size:40px">${heading}</h1>
  <p class="muted" style="font-size:18px;max-width:560px">${text}</p>
  <button class="cta" style="align-self:flex-start">Prendre rendez-vous</button>
  <div style="display:flex;gap:16px;margin-top:24px">
    <div class="card" style="flex:1"><strong>Rapide</strong><p class="muted">Deux minutes suffisent.</p></div>
    <div class="card" style="flex:1"><strong>Près de chez toi</strong><p class="muted">Des praticiens autour de toi.</p></div>
    <div class="card" style="flex:1"><strong>Gratuit</strong><p class="muted">Aucun frais pour les patients.</p></div>
  </div>
</main>`,
  );
  return page(title, [{ file: "screen-1.html", title, width: 1200, height: 640, html }], {}, designSystem);
}

export const lumoraPages = (designSystem: string): PageSpec[] => [
  onboardingPage(designSystem),
  simpleDesktopPage("Landing page", "Trouve ton prochain rendez-vous santé", "Lumora met en relation patients et praticiens disponibles, sans appel ni attente.", designSystem),
  simpleDesktopPage("Planning", "Ton planning de la semaine", "Visualise les créneaux confirmés, déplacés et libres au même endroit.", designSystem),
  simpleDesktopPage("Profil", "Ton profil praticien", "Présentation, spécialités et tarifs visibles par les patients.", designSystem),
  simpleDesktopPage("Facturation", "Facturation et paiements", "Suis les paiements reçus et télécharge tes justificatifs.", designSystem),
];

export const blogPages = (designSystem: string): PageSpec[] => [
  simpleDesktopPage("Article", "Pourquoi le rendez-vous en ligne change tout", "Un article de blog sur les rendez-vous santé en ligne et ce qu'ils changent pour les cabinets.", designSystem),
];

function thumbnail(title: string, tone: string): string {
  return screen(title, `<main class="dark" style="height:640px;display:flex;align-items:flex-end;padding:24px;background:${tone}"><h1 style="font-size:34px">${title}</h1></main>`);
}

export const reelsPages: PageSpec[] = [
  page("Miniatures", [
    { file: "thumb-1.html", title: "Réel 10", width: 360, height: 640, html: thumbnail("Réel 10", "#27272a") },
    { file: "thumb-2.html", title: "Réel 11", width: 360, height: 640, html: thumbnail("Réel 11", "#3f3f46") },
    { file: "thumb-3.html", title: "Réel 12", width: 360, height: 640, html: thumbnail("Réel 12", "#52525b") },
  ]),
  simpleDesktopPage("Storyboard", "Storyboard des réels", "Plan des séquences et textes à l'écran de la prochaine série."),
];
