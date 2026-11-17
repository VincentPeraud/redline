import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommentMode, SetCommentModeResponse, Thread } from "@redline/shared";
import { agree, counted } from "./plural.js";
import { showToast } from "./toasts.js";
import { useMe } from "./useMe.js";
import { Button, Dialog, DialogActions, cx } from "./ui/index.js";
import styles from "./CommentMode.module.css";

const POPOVER_EXIT_MS = 120;
const ONLY_WRITERS_SWITCH = "Seuls les membres en Écriture et les admins changent ce réglage.";

function ConversationIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}

function ModeIcon({ mode }: { mode: CommentMode }) {
  return mode === "conversation" ? <ConversationIcon /> : <span aria-hidden="true" className={styles.dotOn} />;
}

function Explanation({ mode, canSwitch, whyNot, pageTitle }: { mode: CommentMode; canSwitch: boolean; whyNot: string; pageTitle: string }) {
  if (!canSwitch) {
    return (
      <>
        <h3 className={styles.popTitle}>Mode {mode === "agent" ? "Agent" : "Conversation"}</h3>
        <span>{mode === "agent" ? "Les commentaires de cette page partent tout de suite à l'agent du projet." : "Les commentaires de cette page attendent qu'une conversation Claude les prenne."}</span>
        <div className={styles.warn}>
          {ONLY_WRITERS_SWITCH} {whyNot}
        </div>
      </>
    );
  }
  return (
    <>
      <h3 className={styles.popTitle}>Qui traite les commentaires de cette page</h3>
      <div className={styles.option}>
        <span className={styles.optionIcon}>
          <ConversationIcon />
        </span>
        <span>
          <b>Conversation</b> : les commentaires attendent. Dis « traite les commentaires de {pageTitle} » à une conversation Claude Code reliée à ce Redline, sur n'importe quel ordinateur : elle les prend et y répond.
        </span>
      </div>
      <div className={styles.option}>
        <span className={styles.optionIcon}>
          <span aria-hidden="true" className={styles.dotOn} />
        </span>
        <span>
          <b>Agent</b> : chaque commentaire part tout de suite à l'agent du projet, qui le traite seul.
        </span>
      </div>
      <div className={styles.note}>« Confier à l'agent » sur un fil l'envoie à l'agent sans changer le mode de la page.</div>
    </>
  );
}

interface ToggleProps {
  mode: CommentMode;
  /** Members with Écriture and admins switch; for the others the toggle is shown disabled. */
  canSwitch: boolean;
  /** Said under "Seuls les membres en Écriture et les admins changent ce réglage." when the viewer cannot switch: "Tu as le droit Commentaire." */
  whyNot: string;
  pageTitle: string;
  onSelect: (mode: CommentMode) => void;
  /** "header": inline, left of the agent pill. "panel": the phone layout, at the top of the comments panel, full width. */
  placement: "header" | "panel";
}

/** "Commentaires · Conversation / Agent": who handles the page's new comments. The label opens the explanation of both modes. */
export function CommentModeToggle({ mode, canSwitch, whyNot, pageTitle, onSelect, placement }: ToggleProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLButtonElement>(null);
  const panel = placement === "panel";

  const close = () => {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, POPOVER_EXIT_MS);
  };

  useEffect(() => {
    if (!open || closing) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      label.current?.focus();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closing]);

  return (
    <div ref={root} data-testid={panel ? "comment-mode-phone" : "comment-mode"} className={cx(styles.mode, panel && styles.modePanel)}>
      <button ref={label} type="button" aria-haspopup="dialog" aria-expanded={open && !closing} className={cx(styles.label, panel && styles.labelPanel)} onClick={() => (open && !closing ? close() : setOpen(true))}>
        {panel ? "Qui traite les commentaires ⓘ" : "Commentaires"}
      </button>
      <div role="group" aria-label="Qui traite les commentaires" title={canSwitch ? undefined : ONLY_WRITERS_SWITCH} className={cx(styles.seg, !canSwitch && styles.segOff, panel && styles.segPanel)}>
        <button type="button" aria-pressed={mode === "conversation"} disabled={!canSwitch} onClick={() => onSelect("conversation")}>
          <ConversationIcon />
          Conversation
        </button>
        <button type="button" aria-pressed={mode === "agent"} disabled={!canSwitch} onClick={() => onSelect("agent")}>
          Agent
        </button>
      </div>
      {open && (
        <div role="dialog" aria-label="Qui traite les commentaires" data-closing={closing || undefined} className={cx(styles.pop, panel && styles.popPanel)}>
          <Explanation mode={mode} canSwitch={canSwitch} whyNot={whyNot} pageTitle={pageTitle} />
        </div>
      )}
    </div>
  );
}

/** What switching a page to Agent does to its open threads: the threads to take leave, the taken ones stay with their taker. */
function leavingAndStaying(threads: Thread[], meId: string | undefined): { leaving: number; mine: number; others: Map<string, number> } {
  const open = threads.filter((thread) => thread.status === "open");
  const others = new Map<string, number>();
  let mine = 0;
  for (const thread of open) {
    const { take } = thread;
    if (!take) continue;
    const isMine = take.person === undefined ? meId === undefined : take.person.id === meId;
    if (isMine) mine++;
    else {
      const name = take.person?.name || take.person?.email || "quelqu'un";
      others.set(name, (others.get(name) ?? 0) + 1);
    }
  }
  return { leaving: open.filter((thread) => thread.toTake).length, mine, others };
}

function ConfirmAgentDialog({ pageTitle, threads, agentOnline, closing, onCancel, onConfirm }: { pageTitle: string; threads: Thread[]; agentOnline: boolean; closing: boolean; onCancel: () => void; onConfirm: () => void }) {
  const meId = useMe()?.id;
  const { leaving, mine, others } = leavingAndStaying(threads, meId);
  const stays = mine + [...others.values()].reduce((sum, count) => sum + count, 0);
  const total = leaving + stays;
  const line = (count: number, children: ReactNode) => (
    <li key={String(children)}>
      <span className={styles.count}>
        <span>{count}</span>
      </span>
      <span>{children}</span>
    </li>
  );
  const takers = [...others.keys(), ...(mine > 0 ? ["toi"] : [])].map((taker) => `par ${taker}`);
  const takerList = takers.length > 1 ? `${takers.slice(0, -1).join(", ")} et ${takers.at(-1)}` : takers[0];
  return (
    <Dialog title="Passer la page en mode Agent" width={480} onClose={onCancel} closing={closing}>
      <p className={styles.dialogText}>
        {agentOnline
          ? `Les nouveaux commentaires de « ${pageTitle} » partiront tout de suite à l'agent du projet.${total > 0 ? ` Pour les ${counted(total, "fil ouvert", "fils ouverts")} :` : ""}`
          : "L'agent du projet ne tourne pas. Les commentaires attendront son retour, en restant visibles sur leur fil. Une conversation pourra toujours les prendre."}
      </p>
      {total > 0 && (
        <ul className={styles.counts}>
          {agentOnline ? (
            <>
              {leaving > 0 && line(leaving, `${agree(leaving, "fil à prendre part", "fils à prendre partent")} à l'agent maintenant.`)}
              {[...others].map(([name, count]) => line(count, `${agree(count, "fil pris", "fils pris")} par ${name} lui ${agree(count, "reste", "restent")}.`))}
              {mine > 0 && line(mine, `${agree(mine, "fil pris", "fils pris")} par toi te ${agree(mine, "reste", "restent")}.`)}
            </>
          ) : (
            <>
              {leaving > 0 && line(leaving, `${agree(leaving, "fil à prendre passe", "fils à prendre passent")} en attente de l'agent.`)}
              {stays > 0 && line(stays, `${agree(stays, "fil pris", "fils pris")} (${takerList}) ${agree(stays, "reste à son preneur", "restent à leur preneur")}.`)}
            </>
          )}
        </ul>
      )}
      <DialogActions>
        <Button size="lg" onClick={onCancel}>
          Annuler
        </Button>
        <Button size="lg" variant="primary" onClick={onConfirm}>
          Passer en mode Agent
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const DIALOG_EXIT_MS = 140;

/** The Conversation / Agent switch of a page: Agent asks for a confirmation (the dialog to render once), Conversation goes straight and says what moved. */
export function useCommentModeSwitch({ pageId, pageTitle, mode, threads, agentOnline, onSwitched }: { pageId: string; pageTitle: string; mode: CommentMode; threads: Thread[]; agentOnline: boolean; onSwitched: () => void }) {
  const [confirming, setConfirming] = useState<"open" | "closing" | null>(null);

  async function apply(next: CommentMode): Promise<void> {
    const failed = (reason: string): void => {
      showToast({ tone: "error", message: `Le mode n'a pas pu être changé : ${reason}.`, action: { label: "Réessayer", onClick: () => void apply(next) } });
    };
    const response = await fetch(`/api/pages/${pageId}/comment-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: next }) }).catch(() => undefined);
    if (!response) return failed("connexion perdue");
    if (!response.ok) return failed(((await response.json().catch(() => undefined)) as { error?: string } | undefined)?.error ?? "le serveur a refusé");
    const { movedThreads } = (await response.json()) as SetCommentModeResponse;
    onSwitched();
    if (next === "conversation") {
      showToast({
        message:
          movedThreads > 0
            ? `Page repassée en mode Conversation : ${counted(movedThreads, "fil en attente de l'agent redevient", "fils en attente de l'agent redeviennent")} à prendre. Ceux qu'il a commencés lui restent.`
            : "Page repassée en mode Conversation : les nouveaux commentaires attendent qu'une conversation les prenne.",
      });
    }
  }

  const closeConfirmation = (then?: () => void) => {
    setConfirming("closing");
    setTimeout(() => {
      setConfirming(null);
      then?.();
    }, DIALOG_EXIT_MS);
  };

  return {
    select(next: CommentMode) {
      if (next === mode) return;
      if (next === "agent") setConfirming("open");
      else void apply(next);
    },
    dialog:
      confirming === null ? null : (
        <ConfirmAgentDialog pageTitle={pageTitle} threads={threads} agentOnline={agentOnline} closing={confirming === "closing"} onCancel={() => closeConfirmation()} onConfirm={() => closeConfirmation(() => void apply("agent"))} />
      ),
  };
}

/** The line of the Conversation tab while no agent runs for the project: the other way to have the comments handled. */
export function NoAgentHint({ pageTitle }: { pageTitle: string }) {
  return (
    <div data-testid="no-agent-hint" className={styles.hint}>
      <span className={styles.hintIcon}>
        <ConversationIcon />
      </span>
      <span>Aucun agent ne tourne pour ce projet. Demande « traite les commentaires de {pageTitle}&nbsp;» à une conversation Claude Code.</span>
    </div>
  );
}

/** The line at the top of the comments panel: where the page's comments go, per mode and level. */
export function CommentModeHint({ mode, toTake, canWork, pageTitle }: { mode: CommentMode; toTake: number; canWork: boolean; pageTitle: string }) {
  if (mode === "agent") {
    return (
      <div data-testid="comment-hint" className={styles.hint}>
        <span className={styles.hintIcon}>
          <span aria-hidden="true" className={styles.dotOn} />
        </span>
        <span>
          <b>Mode Agent.</b> Les nouveaux commentaires partent tout de suite à l'agent du projet.
        </span>
      </div>
    );
  }
  return (
    <div data-testid="comment-hint" className={styles.hint}>
      <span className={styles.hintIcon}>
        <ConversationIcon />
      </span>
      <span>
        <b>{toTake === 0 ? "Aucun commentaire à prendre." : `${counted(toTake, "commentaire", "commentaires")} à prendre.`}</b>{" "}
        {canWork ? `Dis « traite les commentaires de ${pageTitle} » à une conversation Claude.` : "Les membres en Écriture les traitent avec Claude."}
      </span>
    </div>
  );
}
