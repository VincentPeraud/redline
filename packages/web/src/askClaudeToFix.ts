import type { Conversation, CreateConversationMessageRequest } from "@redline/shared";
import { viaProjectField } from "./viaProject.js";

/** Posts `body` in the page's most recent open conversation, creating one when there is none; answers with that conversation's id. */
export async function postInPageConversation(pageId: string, body: string): Promise<string> {
  const list = (await (await fetch(`/api/pages/${pageId}/conversations`)).json()) as Conversation[];
  const latest = list.filter((c) => !c.archived).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  const conversationId =
    latest?.id ??
    ((await (await fetch(`/api/pages/${pageId}/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(viaProjectField(pageId)) })).json()) as Conversation).id;
  const request: CreateConversationMessageRequest = { body };
  const res = await fetch(`/api/conversations/${conversationId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  if (!res.ok) throw new Error("message");
  return conversationId;
}
