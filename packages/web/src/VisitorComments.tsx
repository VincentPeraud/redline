import { useState, type FormEvent } from "react";
import { MAX_VISITOR_NAME_LENGTH, type Thread, type ThreadReply } from "@redline/shared";
import { Button, Field, Textarea, TextInput } from "./ui/index.js";
import { rememberVisitorName, rememberedVisitorName } from "./visitorName.js";
import type { VisitorState } from "./visitor.js";
import styles from "./VisitorComments.module.css";

/** The name a visitor signs with: the person of a personal link, else the one remembered on this device (empty until given). */
export function signedName(visitor: VisitorState): string {
  return visitor.view.kind === "personal" ? visitor.view.name : rememberedVisitorName();
}

/** Where a thread sits, as a visitor reads it: "Planifier une sortie · bouton « Créer la sortie »". */
function whereLabel(thread: Thread, artboardTitles: Record<string, string>): string {
  const artboard = artboardTitles[thread.artboard] ?? thread.artboard;
  if (thread.target.kind === "artboard") return `${artboard} · Artboard entier`;
  return `${artboard} · ${thread.elementName ?? thread.selector}`;
}

function replyAuthor(reply: ThreadReply, mine: (name: string) => boolean): string {
  if (reply.author === "claude") return "Claude";
  if (reply.author === "redline") return "Redline";
  if (reply.linkAuthor) return mine(reply.linkAuthor.name) ? `Toi (${reply.linkAuthor.name})` : reply.linkAuthor.name;
  return reply.person?.name ?? "L'équipe";
}

/** "Commentaires de ce lien · N": the visitor's own comments and those of the others holding the link. Never the team's. */
export function VisitorThreadsPanel({ threads, visitor, artboardTitles, onShow }: { threads: Thread[]; visitor: VisitorState; artboardTitles: Record<string, string>; onShow?: (threadId: string) => void }) {
  return (
    <aside aria-label="Commentaires de ce lien" className={styles.panel}>
      <h2 className={styles.title}>Commentaires de ce lien · {threads.length}</h2>
      <p className={styles.hint}>Les tiens et ceux des autres personnes de ce lien. Clique sur un élément en mode Commenter pour en poser un : l'équipe les lit avant de les confier à Claude.</p>
      <VisitorThreadCards threads={threads} visitor={visitor} artboardTitles={artboardTitles} onShow={onShow} />
    </aside>
  );
}

export function VisitorThreadCards({ threads, visitor, artboardTitles, onShow }: { threads: Thread[]; visitor: VisitorState; artboardTitles: Record<string, string>; onShow?: (threadId: string) => void }) {
  const me = signedName(visitor);
  const mine = (name: string) => name === me;
  return (
    <>
      {threads.map((thread) => (
        <button type="button" key={thread.id} data-testid="visitor-thread" className={styles.card} onClick={() => onShow?.(thread.id)}>
          <span className={styles.where}>
            <span className={styles.pin}>{thread.number}</span>
            {whereLabel(thread, artboardTitles)}
          </span>
          <span className={styles.who}>{thread.linkAuthor ? (mine(thread.linkAuthor.name) ? `Toi (${thread.linkAuthor.name})` : thread.linkAuthor.name) : "L'équipe"}</span>
          <span>{thread.body}</span>
          {thread.replies.map((reply) => (
            <span key={reply.id} className={styles.reply}>
              <span className={styles.who}>{replyAuthor(reply, mine)}</span>
              <span>{reply.body}</span>
            </span>
          ))}
        </button>
      ))}
    </>
  );
}

/**
 * The comment being written, with the name asked once: "Avant ton premier commentaire" on a generic link, then "Tu commentes en tant que Marc · changer".
 * A personal link never asks: it signs with its own name. A card beside the canvas on a desktop, a sheet at the bottom of a phone.
 */
export function VisitorComposer({ visitor, label, text, onText, onSend, onCancel }: { visitor: VisitorState; label: string; text: string; onText: (text: string) => void; onSend: (visitorName: string) => void | Promise<void>; onCancel: () => void }) {
  const personal = visitor.view.kind === "personal";
  const [name, setName] = useState(() => signedName(visitor));
  const [asking, setAsking] = useState(!personal && rememberedVisitorName() === "");
  const canSend = text.trim() !== "" && (personal || name.trim() !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const signed = personal ? visitor.view.name : name.trim();
    if (!personal) rememberVisitorName(signed);
    await onSend(signed);
  }

  return (
    <form className={styles.composer} onSubmit={submit} aria-label="Nouveau commentaire">
      {asking && (
        <>
          <div className={styles.composerIntro}>
            <h2>Avant ton premier commentaire</h2>
            <p>Ton nom signe tes commentaires pour l'équipe. Il est retenu sur cet appareil.</p>
          </div>
          <Field label="Ton nom">
            <TextInput autoFocus autoComplete="name" maxLength={MAX_VISITOR_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <div className={styles.sep} />
        </>
      )}
      {!asking && (
        <span className={styles.known}>
          Tu commentes en tant que <strong>{personal ? visitor.view.name : name}</strong>
          {!personal && (
            <>
              {" · "}
              <button type="button" className={styles.change} onClick={() => setAsking(true)}>
                changer
              </button>
            </>
          )}
        </span>
      )}
      <Field label={`Commentaire sur « ${label} »`}>
        <Textarea autoFocus={!asking} className={styles.area} value={text} onChange={(event) => onText(event.target.value)} />
      </Field>
      <div className={styles.row}>
        <Button type="button" size="lg" onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" variant="accent" size="lg" disabled={!canSend}>
          Envoyer
        </Button>
      </div>
    </form>
  );
}
