import { useState } from "react";
import type { CreateReplyRequest } from "@redline/shared";
import type { ModelEffortChoice } from "./ModelEffortControls.js";
import { Button, Textarea } from "./ui/index.js";
import styles from "./Thread.module.css";

/** Composer for the user's reply in a thread; sending resumes the thread's session with the panel's model and effort. */
export function ThreadReplyForm({ threadId, choice, onDone }: { threadId: string; choice: ModelEffortChoice; onDone: () => void }) {
  const [text, setText] = useState("");

  async function send() {
    if (text.trim() === "") return;
    const request: CreateReplyRequest = { body: text, ...choice };
    await fetch(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setText("");
    onDone();
  }

  return (
    <div className={styles.replyForm}>
      <Textarea
        aria-label="Répondre"
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className={styles.replyActions}>
        <Button size="sm" onClick={onDone}>
          Annuler
        </Button>
        <Button size="sm" variant="primary" onClick={() => void send()} disabled={text.trim() === ""}>
          Envoyer la réponse
        </Button>
      </div>
    </div>
  );
}
