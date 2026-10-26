import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const ARTBOARD = `<!doctype html><html><body>
  <main>
    <h1 id="title">  Bienvenue  </h1>
    <p id="intro">Trouvez un remplaçant près de chez vous, très vite.</p>
    <label for="mail">E-mail</label><input id="mail" placeholder="vous@exemple.fr">
    <label>Mot de passe <input id="pwd"></label>
    <input id="search" placeholder="Rechercher">
    <input id="aria" aria-label="Ville">
    <input id="bare">
    <button id="go"><span id="go-inner">Continuer</span></button>
    <button id="long">Un libellé de bouton vraiment beaucoup trop long pour tenir</button>
    <button id="icon"><svg id="glyph"></svg></button>
    <input id="submit" type="submit" value="Envoyer">
    <a id="link" href="/x">Voir <b>les tarifs</b></a>
    <img id="photo" src="x.png" alt="Équipe">
    <div id="box"><div id="empty"></div></div>
    <div id="card" style="border: 1px solid #ddd; border-radius: 8px"><p>Intro</p><h3>La maison hantée</h3><p>Détails</p></div>
    <div id="filled" style="background: #eee; border-radius: 6px"><span>Texte <strong>fort</strong></span></div>
    <div id="strong-card" style="background-color: rgb(255, 0, 0); border-radius: 6px"><p>Début <b>Gras</b> fin</p></div>
    <div id="plain-card" style="background-color: rgb(255, 0, 0)"><p>Sans coins arrondis</p></div>
    <div id="lines" style="border: 1px solid #ddd; border-radius: 8px"><span> </span><span>Première ligne</span><span>Seconde</span></div>
    <div id="transparent" style="background: transparent; border-radius: 8px"><span>Rien autour</span></div>
    <div id="holder" style="font-size: 16px; border: 1px solid #ddd; border-radius: 8px"><div id="bold-line" style="font-weight: 700">La maison hantée</div><div id="big-line" style="font-size: 24px">Grand titre</div><div id="slightly-big" style="font-size: 18px">Un peu plus grand</div><div id="normal-line">Ligne normale</div><div id="bold-long" style="font-weight: 600">Un paragraphe en gras beaucoup trop long pour être pris pour un titre de bloc</div><div id="bold-card" style="font-weight: 700; border: 1px solid #ddd; border-radius: 8px">Gras encadré</div><p>Texte <b id="inline-bold">en gras</b></p></div>
  </main>
</body></html>`;

describe("element name computed by the artboard bridge", () => {
  let server: TestServer;
  let bridgeSource: string;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const page = (await (
      await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "home.html": ARTBOARD } })
    ).json()) as Page;
    const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`)).text();
    const src = /<script src="([^"]+bridge\.js)"><\/script>/.exec(html)![1]!;
    bridgeSource = await (await fetch(new URL(src, server.artboardOrigin))).text();
  });
  afterEach(async () => {
    await server.stop();
  });

  /** Clicks the element with the given id in comment mode and returns what the bridge reported. */
  async function pick(id: string): Promise<{ selector: string; elementName: string }> {
    const dom = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
    const { window } = dom;
    let picked: { selector: string; elementName: string } | undefined;
    window.addEventListener("message", (e) => {
      if ((e.data as { type: string }).type === "redline:picked") picked = e.data as typeof picked;
    });
    window.eval(bridgeSource);
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "redline:set-mode", picking: true }, source: window }));
    window.document.getElementById(id)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return picked!;
  }

  it.each([
    ["go", "bouton « Continuer »"],
    ["go-inner", "bouton « Continuer »"],
    ["submit", "bouton « Envoyer »"],
    ["title", "titre « Bienvenue »"],
    ["link", "lien « Voir les tarifs »"],
    ["photo", "image"],
    ["glyph", "image"],
    ["mail", "champ « E-mail »"],
    ["pwd", "champ « Mot de passe »"],
    ["search", "champ « Rechercher »"],
    ["aria", "champ « Ville »"],
    ["bare", "champ"],
    ["intro", "bloc « Trouvez un remplaçant près de… »"],
    ["empty", "bloc"],
    ["card", "carte « La maison hantée »"],
    ["filled", "carte « fort »"],
    ["strong-card", "carte « Gras »"],
    ["plain-card", "bloc « Sans coins arrondis »"],
    ["lines", "carte « Première ligne »"],
    ["transparent", "bloc « Rien autour »"],
    ["icon", "bouton"],
    ["bold-line", "titre « La maison hantée »"],
    ["big-line", "titre « Grand titre »"],
    ["slightly-big", "bloc « Un peu plus grand »"],
    ["normal-line", "bloc « Ligne normale »"],
    ["bold-long", "bloc « Un paragraphe en gras beaucoup… »"],
    ["bold-card", "carte « Gras encadré »"],
    ["inline-bold", "bloc « en gras »"],
  ])("%s is named %s", async (id, expected) => {
    expect((await pick(id)).elementName).toBe(expected);
  });

  it("cuts long text at 30 characters", async () => {
    expect((await pick("long")).elementName).toBe("bouton « Un libellé de bouton vraiment… »");
  });

  it("still reports the exact selector", async () => {
    expect((await pick("go")).selector).toBe("#go");
  });
});
