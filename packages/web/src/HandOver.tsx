import { useState } from "react";
import type { HandOverRefusal, Thread, ThreadTake } from "@redline/shared";
import { relativeTime } from "./relativeTime.js";
import { showToast } from "./toasts.js";
import { useMe } from "./useMe.js";
import { Button, Dialog, DialogActions } from "./ui/index.js";
import dialog from "./CommentMode.module.css";

const DIALOG_EXIT_MS = 140;

const takerName = (take: ThreadTake): string => take.person?.name || take.person?.email || "quelqu'un";
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** Why a call failed, to say in a toast: the server's own reason, or the lost connection. */
async function reasonOf(response: Response | undefined): Promise<string> {
  if (!response) return "connexion perdue";
  const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  return body?.error ? lowerFirst(body.error.replace(/\.$/, "")) : "le serveur a refusé";
}

function ConfirmHandOverDialog({ take, closing, onCancel, onConfirm }: { take: ThreadTake; closing: boolean; onCancel: () => void; onConfirm: () => void }) {
  const me = useMe();
  const name = takerName(take);
  const by = me?.name || me?.email;
  return (
    <Dialog title={`Confier à l'agent un fil pris par ${name}`} width={480} onClose={onCancel} closing={closing}>
      <p className={dialog.dialogText}>
        Une conversation de {name} a pris ce fil {relativeTime(take.takenAt)} ({take.folder}, {take.machine}). Si tu le confies à l'agent, il le traitera ; une réponse de sa conversation sera encore ajoutée au fil, signée.
        {by ? ` Le fil indiquera « confié à l'agent par ${by} ».` : ""}
      </p>
      <DialogActions>
        <Button size="lg" onClick={onCancel}>
          Annuler
        </Button>
        <Button size="lg" variant="primary" onClick={onConfirm}>
          Confier à l'agent
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * "Libérer" and "Confier à l'agent" of a thread card. A thread taken by someone else asks first (the dialog to render once);
 * a thread taken while the member clicked says so in a toast whose button opens that same dialog; a failure says why, with "Réessayer".
 */
export function useThreadHandOver(thread: Thread, onChanged: () => void) {
  const [confirming, setConfirming] = useState<{ take: ThreadTake; closing: boolean } | null>(null);

  async function handOver(confirm: boolean): Promise<void> {
    const response = await fetch(`/api/threads/${thread.id}/hand-over`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm }) }).catch(() => undefined);
    if (response?.ok) return onChanged();
    if (response?.status === 409) {
      const refusal = (await response.clone().json().catch(() => undefined)) as HandOverRefusal | undefined;
      if (refusal?.code === "taken" && refusal.take) {
        const { take } = refusal;
        showToast({ tone: "error", message: `Une conversation de ${takerName(take)} vient de prendre ce fil.`, action: { label: "Voir et confier", onClick: () => setConfirming({ take, closing: false }) } });
        onChanged();
        return;
      }
    }
    showToast({ tone: "error", message: `Le fil n'a pas pu être confié à l'agent : ${await reasonOf(response)}.`, action: { label: "Réessayer", onClick: () => void handOver(confirm) } });
  }

  async function release(): Promise<void> {
    const response = await fetch(`/api/threads/${thread.id}/release`, { method: "POST" }).catch(() => undefined);
    if (response?.ok) return onChanged();
    showToast({ tone: "error", message: `Le fil n'a pas pu être libéré : ${await reasonOf(response)}.`, action: { label: "Réessayer", onClick: () => void release() } });
  }

  const close = (then?: () => void) => {
    setConfirming((current) => current && { ...current, closing: true });
    setTimeout(() => {
      setConfirming(null);
      then?.();
    }, DIALOG_EXIT_MS);
  };

  return {
    /** Asks first when someone else took the thread (`taken`: its take as the card shows it). */
    handOver: (taken: ThreadTake | undefined) => (taken ? setConfirming({ take: taken, closing: false }) : void handOver(false)),
    release: () => void release(),
    dialog: confirming && <ConfirmHandOverDialog take={confirming.take} closing={confirming.closing} onCancel={() => close()} onConfirm={() => close(() => void handOver(true))} />,
  };
}
