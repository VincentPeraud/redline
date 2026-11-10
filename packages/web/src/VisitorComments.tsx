import { useState, type FormEvent } from "react";
import { MAX_VISITOR_NAME_LENGTH, type CreateReplyRequest, type Thread, type ThreadReply } from "@redline/shared";
import { Button, cx, Field, Textarea, TextInput } from "./ui/index.js";
import { rememberVisitorName, rememberedVisitorName } from "./visitorName.js";
import type { VisitorState } from "./visitor.js";
import styles from "./VisitorComments.module.css";
import replyStyles from "./Thread.module.css";

/** The name a visitor signs with: the person of a personal link, else the one remembered on this device (empty until given). */
export function signedName(visitor: VisitorState): string {
  return visitor.view.kind === "personal" ? visitor.view.name : rememberedVisitorName();
}

/** Where a thread sits, as a visitor reads it: "Planifier une sortie · bouton « Créer la sortie »". */
function whereLabel(thread: Thread, artboardTitles: Record<string, string>, otherPages: OtherPages | undefined): string {
  const artboard = artboardTitles[thread.artboard] ?? thread.artboard;
  const place = thread.target.kind === "artboard" ? `${artboard} · Artboard entier` : `${artboard} · ${thread.elementName ?? thread.selector}`;
  return otherPages && thread.pageId !== otherPages.currentPageId ? `${otherPages.titles[thread.pageId] ?? ""} · ${place}` : place;
}

/** A project link in Écriture lists the threads of every page: the titles of the pages, to tell where a thread sits. */
export interface OtherPages {
  currentPageId: string;
  titles: Record<string, string>;
}

function replyAuthor(reply: ThreadReply, mine: (name: string) => boolean, writing: boolean): string {
  if (reply.author === "claude") return "Claude";
  if (reply.author === "redline") return "Redline";
  if (reply.linkAuthor) return writing ? `${reply.linkAuthor.name} (lien)` : mine(reply.linkAuthor.name) ? `Toi (${reply.linkAuthor.name})` : reply.linkAuthor.name;
  return reply.person?.name ?? "L'équipe";
}

/** What an Écriture visitor reads under a comment that waits for an agent. */
export const CLAUDE_UNAVAILABLE_NOTE = "Claude n'est pas disponible pour l'instant : aucun agent ne tourne pour ce projet. Ton commentaire attend, il partira dès qu'un agent sera là.";

/**
 * "Commentaires de ce lien · N": the visitor's own comments and those of the others holding the link, never the team's.
 * An Écriture link reads like a member: "Commentaires · N", every thread of the page.
 */
export function VisitorThreadsPanel({ threads, visitor, artboardTitles, otherPages, claudeAvailable, onShow }: { threads: Thread[]; visitor: VisitorState; artboardTitles: Record<string, string>; otherPages?: OtherPages; claudeAvailable?: boolean; onShow?: (threadId: string) => void }) {
  const writing = visitor.view.level === "write";
  return (
    <aside aria-label={writing ? "Commentaires" : "Commentaires de ce lien"} className={cx(styles.panel, writing && styles.panelWide)}>
      <h2 className={styles.title}>{writing ? "Commentaires" : "Commentaires de ce lien"} · {threads.length}</h2>
      <p className={styles.hint}>
        {writing
          ? `En Écriture, tu vois tous les fils ${visitor.view.scope === "project" ? "du projet" : "de la page"}, et tes commentaires partent à Claude comme ceux de l'équipe. Tu peux retoucher et restaurer des versions ; pas de partage, d'archivage, de suppression ni d'agent.`
          : "Les tiens et ceux des autres personnes de ce lien. Clique sur un élément en mode Commenter pour en poser un : l'équipe les lit avant de les confier à Claude."}
      </p>
      <VisitorThreadCards threads={threads} visitor={visitor} artboardTitles={artboardTitles} otherPages={otherPages} claudeAvailable={claudeAvailable} onShow={onShow} />
    </aside>
  );
}

export function VisitorThreadCards({ threads, visitor, artboardTitles, otherPages, claudeAvailable, onShow }: { threads: Thread[]; visitor: VisitorState; artboardTitles: Record<string, string>; otherPages?: OtherPages; claudeAvailable?: boolean; onShow?: (threadId: string) => void }) {
  const me = signedName(visitor);
  const writing = visitor.view.level === "write";
  const mine = (name: string) => name === me;
  const authorOf = (thread: Thread): string => {
    if (thread.linkAuthor) return writing ? `${thread.linkAuthor.name} (lien)` : mine(thread.linkAuthor.name) ? `Toi (${thread.linkAuthor.name})` : thread.linkAuthor.name;
    return writing ? (thread.person?.name ?? "L'équipe") : "L'équipe";
  };
  return (
    <>
      {threads.map((thread) => (
        <div key={thread.id} className={styles.item}>
          <button type="button" data-testid="visitor-thread" className={styles.card} onClick={() => onShow?.(thread.id)}>
            <span className={styles.where}>
              <span className={cx(styles.pin, writing && styles.pinFilled)}>{thread.number}</span>
              {whereLabel(thread, artboardTitles, otherPages)}
            </span>
            <span className={styles.who}>{authorOf(thread)}</span>
            <span>{thread.body}</span>
            {thread.replies.map((reply) => (
              <span key={reply.id} className={styles.reply}>
                <span className={styles.who}>{replyAuthor(reply, mine, writing)}</span>
                <span>{reply.body}</span>
              </span>
            ))}
            {writing && claudeAvailable === false && thread.status === "open" && thread.replies.length === 0 && thread.linkAuthor && mine(thread.linkAuthor.name) && (
              <span role="status" className={styles.wait}>
                {CLAUDE_UNAVAILABLE_NOTE}
              </span>
            )}
          </button>
          {thread.status !== "resolved" && <VisitorReply threadId={thread.id} visitor={visitor} />}
        </div>
      ))}
    </>
  );
}

/** "Répondre" under a thread the visitor reads, in the style of the members' reply: the reply is signed with the link's name, or the name given on a generic link. */
function VisitorReply({ threadId, visitor }: { threadId: string; visitor: VisitorState }) {
  const personal = visitor.view.kind === "personal";
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [name, setName] = useState(() => signedName(visitor));
  const [failed, setFailed] = useState(false);
  const canSend = text.trim() !== "" && (personal || name.trim() !== "");

  async function send() {
    if (!canSend) return;
    const signed = personal ? visitor.view.name : name.trim();
    const request: CreateReplyRequest = { body: text, visitorName: signed };
    const response = await fetch(`/api/threads/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    if (!response.ok) return setFailed(true);
    if (!personal) rememberVisitorName(signed);
    setText("");
    setFailed(false);
    setOpen(false);
  }

  if (!open) {
    return (
      <div className={styles.replyRow}>
        <Button size="sm" aria-expanded={false} onClick={() => setOpen(true)}>
          Répondre
        </Button>
      </div>
    );
  }
  return (
    <div className={replyStyles.replyForm}>
      {!personal && rememberedVisitorName() === "" && (
        <Field label="Ton nom">
          <TextInput autoComplete="name" maxLength={MAX_VISITOR_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
      )}
      <Textarea aria-label="Répondre" autoFocus rows={2} value={text} onChange={(event) => setText(event.target.value)} />
      {failed && (
        <span role="alert" className={styles.wait}>
          La réponse n'est pas partie, réessaie.
        </span>
      )}
      <div className={replyStyles.replyActions}>
        <Button size="sm" onClick={() => setOpen(false)}>
          Annuler
        </Button>
        <Button size="sm" variant="primary" onClick={() => void send()} disabled={!canSend}>
          Envoyer la réponse
        </Button>
      </div>
    </div>
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
