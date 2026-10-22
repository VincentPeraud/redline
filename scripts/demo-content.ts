import { deflateSync } from "node:zlib";

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
    "manifest.json": JSON.stringify({ title, type: "prototype", ...(designSystem ? { designSystem } : {}), artboards: manifestArtboards, notes: [], links: [], tweaks: [], ...extra }, null, 2),
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
      notes: [{ text: "Parcours en 3 écrans, pensé pour le téléphone.", x: 0, y: 820 }],
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

function dashboardPage(designSystem: string): PageSpec {
  const board = (title: string, heading: string) =>
    screen(
      title,
      `<main style="display:flex;min-height:640px">
  <nav style="width:180px;padding:24px 16px;background:var(--color-surface);display:flex;flex-direction:column;gap:12px"><strong>Lumora</strong><span class="muted">Planning</span><span class="muted">Patients</span></nav>
  <section style="flex-grow:1;padding:32px;display:flex;flex-direction:column;gap:20px">
    <h1>${heading}</h1>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px"><div class="card">Aujourd'hui<p class="muted">8 créneaux</p></div><div class="card">Cette semaine<p class="muted">34 créneaux</p></div><div class="card" style="background:var(--color-primary);color:var(--color-on-primary)">Remplacements<p>3 demandes</p></div></div>
    <div class="card" style="height:220px"></div>
  </section>
</main>`,
    );
  return page(
    "Tableau de bord remplaçant",
    [
      { file: "artboard-1.html", title: "Vue semaine", width: 1000, height: 640, html: board("Vue semaine", "Ta semaine") },
      { file: "artboard-2.html", title: "Vue mois", width: 1000, height: 640, html: board("Vue mois", "Ton mois") },
    ],
    {},
    designSystem,
  );
}

function headerComparisonPage(designSystem: string): PageSpec {
  const variant = (title: string, style: string) =>
    screen(title, `<header style="${style};display:flex;align-items:center;gap:16px;height:72px;padding:0 24px"><strong>Lumora</strong><span style="flex-grow:1"></span><span>Accueil</span><span>Mon compte</span></header>`);
  return page(
    "Comparaison des en-têtes",
    [
      { file: "variant-a.html", title: "A · clair", width: 480, height: 160, html: variant("A · clair", "background:#fff;border-bottom:1px solid var(--color-border)") },
      { file: "variant-b.html", title: "B · teinté", width: 480, height: 160, html: variant("B · teinté", "background:#FDE3DF") },
      { file: "variant-c.html", title: "C · plein", width: 480, height: 160, html: variant("C · plein", "background:var(--color-primary);color:var(--color-on-primary)") },
    ],
    {},
    designSystem,
  );
}

function doctorProfilePage(designSystem: string): PageSpec {
  const html = screen(
    "Profil médecin",
    `<main style="padding:56px 24px 32px;display:flex;flex-direction:column;align-items:center;gap:16px;min-height:760px">
  <div style="width:80px;height:80px;border-radius:50%;background:#FDE3DF"></div>
  <h1 style="font-size:22px">Dr Claire Martin</h1>
  <p class="muted">Médecin généraliste · Lyon</p>
  <div class="row" style="align-self:stretch">Disponibilités</div>
  <div class="row" style="align-self:stretch">Tarifs</div>
</main>`,
  );
  return page("Profil médecin", [{ file: "artboard-1.html", title: "Profil", ...PHONE, html }], {}, designSystem);
}

export const lumoraPages = (designSystem: string): PageSpec[] => [
  onboardingPage(designSystem),
  simpleDesktopPage("Landing page", "Trouve ton prochain rendez-vous santé", "Lumora met en relation patients et praticiens disponibles, sans appel ni attente.", designSystem),
  dashboardPage(designSystem),
  headerComparisonPage(designSystem),
  doctorProfilePage(designSystem),
];

export const lumoraDesignMd = `# Direction
Ton rassurant et sobre, pour des professionnels de santé pressés. Mobile d'abord, 390 px.

# Règles
- Une seule action principale par écran
- Boutons principaux pleins, couleur primaire
- Listes de choix en boutons radio, jamais en menu déroulant
- La semaine commence le lundi
`;

/** A PNG of `width` x `height` pixels, each pixel given by `pixel(x, y)` as [r, g, b, a]. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Shared assets of the Lumora project, as shown on the Overview board. */
export function lumoraAssets(): Record<string, Buffer | string> {
  const assets: Record<string, Buffer | string> = {
    "logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="24" viewBox="0 0 96 24"><rect x="0" y="3" width="18" height="18" rx="5" fill="#D92D20"/><text x="24" y="19" font-family="Inter, sans-serif" font-size="15" font-weight="700" fill="#18181B">lumora</text></svg>`,
    "hero-cabinet.jpg": png(153, 72, (x, y) => (x > 8 && x < 70 && y > 28 ? [168, 182, 208, 255] : [201, 211, 230, 255])),
    "avatar-medecin.png": png(72, 72, (x, y) => ((x - 36) ** 2 + (y - 36) ** 2 < 20 ** 2 ? [230, 211, 194, 255] : [243, 242, 238, 255])),
    "illu-calendrier.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="153" height="72" viewBox="0 0 153 72"><rect width="153" height="72" fill="#FDE3DF"/><rect x="55" y="17" width="44" height="38" rx="4" fill="#fff"/><path d="M55 21a4 4 0 0 1 4-4h36a4 4 0 0 1 4 4v4H55z" fill="#D92D20"/></svg>`,
    "fonts/Inter-Regular.woff2": "inter regular",
    "fonts/Inter-Bold.woff2": "inter bold",
  };
  for (let i = 1; i <= 24; i++) assets[`icones/icone-${String(i).padStart(2, "0")}.svg`] = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#3F3F46" stroke-width="2"/></svg>`;
  return assets;
}

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
