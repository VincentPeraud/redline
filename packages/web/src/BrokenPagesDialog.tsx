import { useState } from "react";
import type { BrokenElement, BrokenPage, BrokenPlace } from "@redline/shared";
import { agree, counted } from "./plural.js";
import { Button, DIALOG_EXIT_MS, Dialog, DialogActions } from "./ui/index.js";
import styles from "./BrokenPagesDialog.module.css";

const Mono = ({ children }: { children: string }) => <span className={styles.mono}>{children}</span>;

const BLOCKS = "la page ne pourra plus être publiée tant qu'elle l'utilise";
const RENDERS_WITHOUT = "s'affiche sans elle";

/** One broken element of a page, as the dialog words it when the draft removed it. */
function ElementLine({ element }: { element: BrokenElement }) {
  switch (element.kind) {
    case "component":
      return (
        <span>
          <Mono>{element.name}</Mono> · composant retiré du brouillon : {BLOCKS}
        </span>
      );
    case "setting":
      return (
        <span>
          <Mono>{element.name}</Mono> · réglage « {element.setting} » retiré du brouillon : {BLOCKS}
        </span>
      );
    case "value":
      return (
        <span>
          <Mono>{`${element.name} ${element.setting}="${element.value}"`}</Mono> · valeur retirée du brouillon : {BLOCKS}
        </span>
      );
    case "slot":
      return (
        <span>
          <Mono>{element.name}</Mono> · emplacement « {element.slot} » retiré du brouillon : {BLOCKS}
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
          ) : (
            "variable retirée du brouillon"
          )}{" "}
          : {RENDERS_WITHOUT}
        </span>
      );
  }
}

const placeText = (place: BrokenPlace) => (place.instances === undefined ? place.artboard : `${place.artboard} · ${counted(place.instances, "instance", "instances")}`);

/** "Passer sur le brouillon de Locoum ?": the pages the draft breaks, and the choice to switch anyway. */
export function BrokenPagesDialog({
  designSystemTitle,
  pendingChanges,
  pages,
  failed,
  onConfirm,
  onClose,
}: {
  designSystemTitle: string;
  pendingChanges: number;
  pages: BrokenPage[];
  /** The confirmation did not reach the server: the dialog says so and stays open. */
  failed: boolean;
  /** Resolves true when the project switched: the dialog then closes. */
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, DIALOG_EXIT_MS);
  };
  async function confirm() {
    setBusy(true);
    const switched = await onConfirm();
    setBusy(false);
    if (switched) close();
  }

  return (
    <Dialog title={`Passer sur le brouillon de ${designSystemTitle} ?`} onClose={close} width={600} closing={closing}>
      <p className={styles.text}>
        Ce projet verra les <strong>{counted(pendingChanges, "modification", "modifications")} pas encore {agree(pendingChanges, "diffusée", "diffusées")}</strong> de {designSystemTitle}, sur toutes ses pages et pour les visiteurs par lien. Le brouillon a retiré des éléments qu'une page utilise encore :
      </p>
      <ul className={styles.pages} data-testid="broken-pages">
        {pages.map((page) => (
          <li key={page.pageId} className={styles.page} data-testid={`broken-${page.title}`}>
            <span className={styles.pageTitle}>{page.title}</span>
            <span className={styles.elements}>
              {page.elements.flatMap((element) => [
                <ElementLine key={`${element.kind}-${element.name}-${element.setting}-${element.value}-${element.slot}`} element={element} />,
                <span key={`${element.kind}-${element.name}-${element.setting}-${element.value}-${element.slot}-places`} className={styles.places}>
                  {element.places.map(placeText).join(", ")}
                </span>,
              ])}
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>Si tu passes quand même, la page reçoit un fil « Retrait dans le design system » qui liste ces éléments.</p>
      {failed && (
        <p role="alert" className={styles.error}>
          Le changement n'a pas été enregistré (connexion perdue). Le projet suit toujours la dernière diffusion.
        </p>
      )}
      <DialogActions>
        <Button onClick={close}>Annuler</Button>
        <Button variant="primary" disabled={busy || closing} onClick={() => void confirm()}>
          Passer quand même
        </Button>
      </DialogActions>
    </Dialog>
  );
}
