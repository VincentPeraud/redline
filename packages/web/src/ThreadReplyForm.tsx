import { useState } from "react";
import type { CreateReplyRequest } from "@redline/shared";

/** Composer for the user's reply in a thread; sending resumes the thread's session. */
export function ThreadReplyForm({ threadId }: { threadId: string }) {
  const [text, setText] = useState("");

  async function send() {
    if (text.trim() === "") return;
    const request: CreateReplyRequest = { body: text };
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
      <button onClick={() => void send()}>Reply</button>
    </div>
  );
}
