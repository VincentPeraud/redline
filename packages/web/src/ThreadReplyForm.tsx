import { useState } from "react";
import type { CreateReplyRequest } from "@redline/shared";
import { ModelEffortControls, type ModelEffortChoice } from "./ModelEffortControls.js";

/** Composer for the user's reply in a thread; sending resumes the thread's session. */
export function ThreadReplyForm({ threadId }: { threadId: string }) {
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelEffortChoice>({});

  async function send() {
    if (text.trim() === "") return;
    const request: CreateReplyRequest = { body: text, ...choice };
    await fetch(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setText("");
  }

  return (
    <div>
      <textarea
        aria-label="Reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      <ModelEffortControls value={choice} onChange={setChoice} />
      <button onClick={() => void send()}>Reply</button>
    </div>
  );
}
