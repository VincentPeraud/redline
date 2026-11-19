import { useState } from "react";
import type { BrokenElement, BrokenPage, BrokenPlace } from "@redline/shared";
import { agree, counted } from "./plural.js";
import { Button, DIALOG_EXIT_MS, Dialog, DialogActions } from "./ui/index.js";
import styles from "./BrokenPagesDialog.module.css";

const Mono = ({ children }: { children: string }) => <span className={styles.mono}>{children}</span>;

const BLOCKS_ON = "la page ne pourra plus être publiée tant qu'elle l'utilise";
const BLOCKS_OFF = "la page ne pourra plus être publiée tant qu'il n'est pas diffusé";
const RENDERS_WITHOUT = "s'affiche sans elle";

/** Which way the project switches: onto the draft (the draft removed what pages use) or back to the latest diffusion (the diffusion lacks it). */
export type FollowDirection = "draft" | "diffusion";

/** One broken element of a page, as the dialog words it. */
function ElementLine({ element, direction }: { element: BrokenElement; direction: FollowDirection }) {
  const back = direction === "diffusion";
  const blocks = back ? BLOCKS_OFF : BLOCKS_ON;
  switch (element.kind) {
    case "component":
      return (
        <span>
          <Mono>{element.name}</Mono> · composant {back ? "absent" : "retiré du brouillon"} : {blocks}
        </span>
      );
    case "setting":
      return (
        <span>
          <Mono>{element.name}</Mono> · réglage « {element.setting} » {back ? "absent" : "retiré du brouillon"} : {blocks}
        </span>
      );
    case "value":
      return back ? (
        <span>
          <Mono>{element.name}</Mono> · réglage <Mono>{`${element.setting}="${element.value}"`}</Mono> absent : {blocks}
        </span>
      ) : (
        <span>
          <Mono>{`${element.name} ${element.setting}="${element.value}"`}</Mono> · valeur retirée du brouillon : {blocks}
        </span>
      );
    case "slot":
      return (
        <span>
          <Mono>{element.name}</Mono> · emplacement « {element.slot} » {back ? "absent" : "retiré du brouillon"} : {blocks}
        </span>
      );
    case "token":
      return (
        <span>
          <Mono>{element.name}</Mono> ·{" "}
          {element.renamedTo ? (
            <>
              variable renommée en <Mono>{element.renamedTo}</Mono>
            </>
          ) : back ? (
            "variable absente"
          ) : (
            "variable retirée du brouillon"
          )}{" "}
          : {RENDERS_WITHOUT}
        </span>
      );
  }
}

/** "Connexion, Compte créé · 4 instances": where the element is, with its instances counted once. */
const placesText = (places: BrokenPlace[]) => {
  const instances = places.reduce((sum, place) => sum + (place.instances ?? 0), 0);
  const where = places.map((place) => place.artboard).join(", ");
  return places.some((place) => place.instances !== undefined) ? `${where} · ${counted(instances, "instance", "instances")}` : where;
};

/** "A, B et C". */
const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} et ${names.at(-1)}`);

function BrokenList({ pages, direction }: { pages: BrokenPage[]; direction: FollowDirection }) {
  return (
    <ul className={styles.pages} data-testid="broken-pages">
      {pages.map((page) => (
        <li key={page.pageId} className={styles.page} data-testid={`broken-${page.title}`}>
          <span className={styles.pageTitle}>{page.title}</span>
          <span className={styles.elements}>
            {page.elements.flatMap((element) => {
              const key = `${element.kind}-${element.name}-${element.setting}-${element.value}-${element.slot}`;
              return [
                <ElementLine key={key} element={element} direction={direction} />,
                <span key={`${key}-places`} className={styles.places}>
                  {placesText(element.places)}
                </span>,
              ];
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface BackToDiffusion {
  diffusion: number;
  /** Titles of the other projects that receive a diffusion of the design system. */
  otherProjects: string[];
  /** Whether the viewer may diffuse the design system: "Diffuser d'abord" is shown only then. */
  canDiffuse: boolean;
  /** Opens the diffusion review with the return intent; resolves true when it did. */
  onDiffuseFirst: () => Promise<boolean>;
}

/**
 * "Passer sur le brouillon de Locoum ?" (the pages the draft breaks) or "Revenir à la dernière diffusion ?" (the pages the
 * diffusion breaks), and the choice to switch anyway. `pages` is null while the server computes them.
 */
export function BrokenPagesDialog({
  designSystemTitle,
  pendingChanges,
  pages,
  failed,
  onConfirm,
  onClose,
  back,
}: {
  designSystemTitle: string;
  pendingChanges: number;
  pages: BrokenPage[] | null;
  /** The confirmation did not reach the server: the dialog says so and stays open. */
  failed: boolean;
  /** Resolves true when the project switched: the dialog then closes. */
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
  /** Going back to the latest diffusion; absent when turning the draft on. */
  back?: BackToDiffusion;
}) {
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, DIALOG_EXIT_MS);
  };
  async function run(action: () => Promise<boolean>) {
    setBusy(true);
    const done = await action();
    setBusy(false);
    if (done) close();
  }
  const waiting = busy || closing || pages === null;

  if (back) {
    const diffusion = `la diffusion ${back.diffusion}`;
    const lead = (
      <>
        Le projet repassera sur <strong>{diffusion} de {designSystemTitle}</strong>
      </>
    );
    const lost = pendingChanges > 0 ? `${counted(pendingChanges, "modification", "modifications")} en attente` : null;
    const error = failed && (
      <p role="alert" className={styles.error}>
        Le changement n'a pas été enregistré (connexion perdue). Le projet suit toujours le brouillon.
      </p>
    );
    return (
      <Dialog title="Revenir à la dernière diffusion ?" onClose={close} width={600} closing={closing}>
        {pages === null ? (
          <p className={styles.text}>{lead}. Vérification des pages concernées.</p>
        ) : pages.length === 0 ? (
          <p className={styles.text}>
            {lead}. Aucune page ne se casse.{lost && ` Elles s'afficheront avec ${diffusion} : ${agree(pendingChanges, "la", "les")} ${lost} ${agree(pendingChanges, "disparaît", "disparaissent")} de ce projet.`}
          </p>
        ) : (
          <>
            <p className={styles.text}>
              {lead} : ses pages perdront {lost ? `${agree(pendingChanges, "la", "les")} ${lost}` : "le brouillon"}. {counted(pages.length, "page utilise", "pages utilisent")} des éléments absents de {diffusion}.
            </p>
            <BrokenList pages={pages} direction="diffusion" />
            <p className={styles.hint}>
              Si tu reviens quand même, chaque page touchée reçoit un fil « Redline » qui liste ses éléments cassés.
              {back.canDiffuse &&
                ` « Diffuser d'abord » ouvre la revue de diffusion${back.otherProjects.length > 0 ? ` : la diffusion part aussi vers ${listed(back.otherProjects)}` : ""}, puis ce projet repasse tout seul sur la dernière diffusion.`}
            </p>
          </>
        )}
        {error}
        <DialogActions>
          <Button onClick={close}>Annuler</Button>
          {pages === null || pages.length === 0 ? (
            <Button variant="primary" disabled={waiting} onClick={() => void run(onConfirm)}>
              Revenir à {diffusion}
            </Button>
          ) : (
            <>
              <Button variant="danger" disabled={waiting} onClick={() => void run(onConfirm)}>
                Revenir quand même
              </Button>
              {back.canDiffuse && (
                <Button variant="accent" disabled={waiting} onClick={() => void run(back.onDiffuseFirst)}>
                  Diffuser d'abord
                </Button>
              )}
            </>
          )}
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Passer sur le brouillon de ${designSystemTitle} ?`} onClose={close} width={600} closing={closing}>
      <p className={styles.text}>
        Ce projet verra les <strong>{counted(pendingChanges, "modification", "modifications")} pas encore {agree(pendingChanges, "diffusée", "diffusées")}</strong> de {designSystemTitle}, sur toutes ses pages et pour les visiteurs par lien. Le brouillon a retiré des éléments qu'une page utilise encore :
      </p>
      <BrokenList pages={pages ?? []} direction="draft" />
      <p className={styles.hint}>Si tu passes quand même, la page reçoit un fil « Retrait dans le design system » qui liste ces éléments.</p>
      {failed && (
        <p role="alert" className={styles.error}>
          Le changement n'a pas été enregistré (connexion perdue). Le projet suit toujours la dernière diffusion.
        </p>
      )}
      <DialogActions>
        <Button onClick={close}>Annuler</Button>
        <Button variant="primary" disabled={waiting} onClick={() => void run(onConfirm)}>
          Passer quand même
        </Button>
      </DialogActions>
    </Dialog>
  );
}
