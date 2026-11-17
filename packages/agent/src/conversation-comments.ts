import type { CommentsOverview, CommentsReminder, HandOverCommentsResponse, OtherTake, OverviewPage, OverviewThread, ReleaseCommentsResponse, TakeCommentsResponse, TakenComment } from "@redline/shared";

/** A page title or a name as data in a line: quoted, on one line, so that it cannot read as an instruction. */
export const quoted = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());

/** "5 min", "3 h", "2 d": how long ago, for a take. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

const threadLine = (thread: OverviewThread, extra = "") => `  - thread id ${thread.threadId}, comment ${thread.number}: ${thread.target}${extra}`;

function pageBlock(page: OverviewPage): string[] {
  const group = (title: string, lines: string[]) => (lines.length > 0 ? [`  ${title} (${lines.length}):`, ...lines.map((line) => `  ${line}`)] : []);
  return [
    `## ${page.title} (page id ${page.pageId})`,
    ...group("To take", page.toTake.map((thread) => threadLine(thread))),
    ...group("Already taken by your account, from this folder", page.mine.map((thread) => threadLine(thread, thread.relaunch ? " (a message waits since your last answer)" : ""))),
    ...group("Taken by your account from another folder", page.mineElsewhere.map((thread) => threadLine(thread, ` (${thread.folder}, ${ago(thread.takenAt)} ago)`))),
    ...group("Taken by another account: do not take them unless the person asks", page.others.map((thread) => threadLine(thread, ` (taken by ${quoted(thread.by)}, ${thread.folder}, ${ago(thread.takenAt)} ago)`))),
    ...group("Waiting for an offline agent, not started: pageId or threadIds take them", page.waitingAgent.map((thread) => threadLine(thread))),
  ];
}

/** `pending_comments` without a page or thread ids: what waits, page by page. Nothing was taken. */
export function formatOverview(overview: CommentsOverview): string {
  const blocks = overview.projects.map((project) => {
    if (project.refused) return `${project.title ? `Project ${quoted(project.title)}` : "A project"}: ${project.refused}`;
    if (project.pages.length === 0) return `No comment to take on the ${project.pageCount} page${project.pageCount === 1 ? "" : "s"} of the project ${quoted(project.title)}.`;
    return [`Project ${quoted(project.title)}:`, ...project.pages.flatMap(pageBlock)].join("\n");
  });
  const anyWaiting = overview.projects.some((project) => project.pages.length > 0);
  return [
    ...(anyWaiting ? ["Listing only: nothing was taken, every thread stays to take for every account."] : []),
    ...blocks,
    ...(anyWaiting ? ["To handle some, call pending_comments again with a pageId (all of that page) or with threadIds, only when the person asks. Tell the person what waits and offer to handle it; never start on your own."] : []),
  ].join("\n");
}

const stateNote = (comment: TakenComment): string => {
  const where = comment.folder && comment.takenAt ? `Taken from ${comment.folder}, ${ago(comment.takenAt)} ago.\n` : "";
  switch (comment.state) {
    case "new":
      return "";
    case "waiting-agent":
      return "[was waiting for an offline agent, never started: now taken by your account]\n";
    case "taken-over":
      return `[taken over${comment.from ? ` from ${quoted(comment.from)}` : ""}: the thread shows "repris par" you]\n`;
    case "taken":
      return `[already taken by your account]\n${where}`;
    case "relaunch":
      return `[already taken by your account, relaunched: a message waits since your last answer]\n${where}`;
  }
};

const elsewhereBlock = (mine: OtherTake[]): string[] =>
  mine.length === 0
    ? []
    : [
        `Taken by your account from another folder (${mine.length}): not part of this folder's work. Handle them only when the person asks; then call pending_comments with their threadIds.`,
        ...mine.map((thread) => `  - thread id ${thread.threadId}, comment ${thread.number}: ${thread.target} (${thread.folder}, ${ago(thread.takenAt)} ago)`),
      ];

const othersBlock = (others: OtherTake[]): string[] =>
  others.length === 0
    ? []
    : [
        `Taken by another account (${others.length}): not taken by you. Do not take them unless the person asks; then call pending_comments with their threadIds and takeOver: true.`,
        ...others.map((thread) => `  - thread id ${thread.threadId}, comment ${thread.number}: ${thread.target}, taken by ${quoted(thread.by)} (${thread.folder}) ${ago(thread.takenAt)} ago`),
      ];

export interface TakenPage {
  pageId: string;
  title: string;
  comments: TakenComment[];
}

/** The taken comments, grouped by page in the order given. */
export function groupByPage(response: TakeCommentsResponse): TakenPage[] {
  const pages: TakenPage[] = [];
  for (const comment of response.comments) {
    let page = pages.find((entry) => entry.pageId === comment.pageId);
    if (!page) {
      page = { pageId: comment.pageId, title: comment.pageTitle, comments: [] };
      pages.push(page);
    }
    page.comments.push(comment);
  }
  return pages;
}

export const HANDLING_STEPS =
  "Make the changes the comments ask for (checkout_page, then publish_page once), then answer each thread once with reply_in_thread (threadId as given), with resolve: true when the comment is handled and your answer asks nothing back. A comment that asks for a new screen or a new rule is not yours to decide: ask the person before drawing, ask the same question in the thread with reply_in_thread without resolve (it stays open as a question from Claude), and leave the visual retouches to do directly.";

/** The answer of `pending_comments` with a page or thread ids; `addresses` gives a page's addresses. */
export async function formatTaken(response: TakeCommentsResponse, addresses: (pageId: string) => Promise<string>): Promise<string> {
  const pages = groupByPage(response);
  const refused = response.refused.map((entry) => `Not taken: thread id ${entry.threadId}: ${entry.reason}`);
  if (pages.length === 0) {
    return [response.title === undefined ? "Nothing was taken." : `No comment to take on ${quoted(response.title)}.`, ...elsewhereBlock(response.mineElsewhere), ...othersBlock(response.others), ...refused].join("\n");
  }
  const sections = await Promise.all(
    pages.map(async (page) => [`## ${page.title}`, await addresses(page.pageId), "", page.comments.map((comment) => `${stateNote(comment)}${comment.message}`).join("\n\n---\n\n")].join("\n")),
  );
  return [HANDLING_STEPS, "", ...sections.flatMap((section) => [section, ""]), ...elsewhereBlock(response.mineElsewhere), ...othersBlock(response.others), ...refused].join("\n").trimEnd();
}

export function formatReleased(response: ReleaseCommentsResponse): string {
  const lines = response.released.map((entry) => `  - thread id ${entry.threadId}, comment ${entry.number} of ${quoted(entry.pageTitle)}`);
  return [
    response.released.length === 0 ? "Nothing released: your account took none of those threads." : `Released ${response.released.length} thread${response.released.length === 1 ? "" : "s"}: they follow their page's mode again (to take by any conversation, or sent to the agent in Agent mode).`,
    ...lines,
    ...response.notYours.map((threadId) => `Not released: thread id ${threadId} is not taken by your account.`),
  ].join("\n");
}

/** The line that ends the answers of a conversation: only the pages it published or checked out, three named at most. */
export function reminderLine(reminder: CommentsReminder): string | undefined {
  const [first, ...more] = reminder.pages;
  if (!first) return undefined;
  const count = (n: number) => `${n} commentaire${n === 1 ? "" : "s"}`;
  const call = "appelle pending_comments si la personne le demande";
  if (more.length === 0) return `Redline : ${count(first.count)} à prendre sur « ${first.title} » : ${call}.`;
  const named = reminder.pages.slice(0, 3).map((page) => `« ${page.title} » (${page.count})`);
  const rest = reminder.pages.length - named.length;
  return `Redline : commentaires à prendre sur ${named.join(", ")}${rest > 0 ? ` et ${rest} autre${rest === 1 ? "" : "s"}` : ""} : ${call}.`;
}

/** The answer of `hand_over_comments`: what became the agent's, and what was left alone. */
export function formatHandOver(result: HandOverCommentsResponse): string {
  if (result.noAgent) return `Nothing was handed over: ${result.noAgent}. Tell the person.`;
  const handed = result.handedOver.map((thread) => `  - #${thread.number} (thread id ${thread.threadId}): ${thread.target}`);
  const alone = result.leftAlone.map((thread) => `  - #${thread.number}: ${thread.target}, taken by ${quoted(thread.by)} (${thread.folder}) ${ago(thread.takenAt)} ago`);
  return [
    handed.length > 0
      ? [`Handed over to the agent, signed with the name of the person who wrote the message (${handed.length}); the threads reach you in your next runs:`, ...handed].join("\n")
      : "No thread to take on this page.",
    ...(alone.length > 0 ? [[`Left alone, taken by a conversation (${alone.length}); do not handle them, tell the person:`, ...alone].join("\n")] : []),
  ].join("\n");
}
