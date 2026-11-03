// Requests to the design system (instances lot, ticket 10). A request is a thread on a component's artboard in the
// design system, created by a project's session; see the "Requests" section of the spec.

/** `in_progress` until the design system's session publishes a change linked to it, then `done_in_draft`; closed by `refused` or `diffused`. */
export type RequestState = "in_progress" | "done_in_draft" | "refused" | "diffused";

/** Where a request comes from: the project page and instance that needed something, and the user's comment Claude routed, if any. */
export interface RequestOrigin {
  projectId: string;
  projectTitle: string;
  pageId: string;
  pageTitle: string;
  /** Artboard file of the instance on the project page. */
  artboard: string;
  /** Selector of the instance on that artboard, when the session gave it. */
  selector?: string;
  /** The user's comment the request was routed from; absent when the project's session asked on its own. */
  threadId?: string;
  /** Redline's message waiting for the page to be unarchived: the diffusion closed the request but the page could not be told yet. */
  pendingReturn?: string;
}

export interface ThreadRequest {
  /** What the request is about; "component" is the only kind for now. */
  kind: "component";
  state: RequestState;
  /** Component name, without the `ui-` prefix ("modal"). */
  component: string;
  /** What the project's session asked for in its own words, kept when the thread's text is the user's comment instead. */
  detail?: string;
  /** Oldest first; the first one is the author of the request. */
  origins: RequestOrigin[];
  /** Labels of the changes the user refused while the rest of the request stayed open: the return at diffusion recalls them. */
  refusedLabels?: string[];
  /** Thread of the request this one was attached to: its origins moved there and this one is closed. */
  mergedInto?: string;
}

/** An open request is still waiting for a diffusion or a refusal: it counts on the artboard header and on the overview. */
export const requestIsOpen = (request: Pick<ThreadRequest, "state" | "mergedInto">): boolean => !request.mergedInto && (request.state === "in_progress" || request.state === "done_in_draft");

/** "ui-modal" and "modal" are the same component: the name without the prefix, lower-cased. */
export const requestComponentName = (component: string): string => component.trim().replace(/^ui-/i, "").toLowerCase();

/** "App · Planning". */
export const requestOriginLabel = (origin: Pick<RequestOrigin, "projectTitle" | "pageTitle">): string => `${origin.projectTitle} · ${origin.pageTitle}`;

/** Body of `POST /agent-api/pages/:pageId/requests`: a project session asks its design system for something the component lacks. */
export interface SendRequestRequest {
  /** The component, as `ui-modal` or `modal`. */
  component: string;
  /** What is missing, in a sentence a designer can act on. */
  missing: string;
  /** Artboard file of this page where the closest instance is. */
  artboard: string;
  /** Selector of that instance on the artboard. */
  selector?: string;
  /** The user's comment this request answers, when Claude routed one. */
  threadId?: string;
  workId?: string;
}

export interface SendRequestResponse {
  /** The request thread, on the component's artboard in the design system. */
  threadId: string;
  designSystemTitle: string;
  /** The design system's page the thread lives on. */
  pageId: string;
}

/** A line of the design system overview's "Demandes des projets" list. */
export interface DesignSystemRequestItem {
  threadId: string;
  pageId: string;
  /** The component's artboard file on that page. */
  artboard: string;
  /** `ui-modal`. */
  tag: string;
  title: string;
  /** "App · Planning" (the first origin). */
  origin: string;
  createdAt: string;
}
