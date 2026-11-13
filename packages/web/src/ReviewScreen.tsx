import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  RESPONSIVE_FORMATS,
  activeSteps,
  progressOf,
  renderingKey,
  renderingLabel,
  stepIsGroup,
  stepIsModified,
  stepIsMultiPage,
  stepIsSeen,
  stepLabel,
  stepStatus,
  versionPreviewPath,
  type ArtboardRef,
  type ArtboardRendering,
  type ChangeReview,
  type ChangeReviewAnswer,
  type ChangeReviewMember,
  type ChangeReviewPresence,
  type ChangeReviewStep,
  type TweakValues,
} from "@redline/shared";
import { ArtboardIframe, useArtboardOrigin } from "./artboardCapability.js";
import { fitToStage } from "./PlayMode.js";
import { PlayFrame } from "./PlayFrame.js";
import { presentationOf } from "./playFrames.js";
import { relativeTime } from "./relativeTime.js";
import { navigateTo, type Route } from "./router.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { TweaksPanel } from "./TweaksPanel.js";
import { useReviewControls, type StepControls } from "./useReviewControls.js";
import { useDocumentTitle } from "./documentTitle.js";
import { cx } from "./ui/index.js";
import { counted } from "./plural.js";
import { ConfirmDialog, LeaveDialog, PersonDot, RemarkEditor, personName } from "./ReviewRemark.js";
import styles from "./ReviewScreen.module.css";

type Load = { status: "loading" } | { status: "missing" } | { status: "refused" } | { status: "error" } | { status: "ready"; review: ChangeReview };

type View = number | "recap";

/** A remark deleted from the recap: "Annuler" puts it back while the review is open; when it was locked meanwhile (`lost`) the text stays here to copy. */
interface RemovedRemark {
  stepId: string;
  text: string;
  title: string;
  lost?: boolean;
}

const reviewPath = (reviewId: string) => `/api/change-reviews/${encodeURIComponent(reviewId)}`;

const PRESENCE_BEAT_MS = 20_000;
const UNDO_REMOVAL_MS = 5_000;

/** First step without an answer after `from`, else any earlier one, else the recap. A removed step is never asked about. */
function nextUnanswered(review: ChangeReview, from: number): View {
  const unanswered = (step: ChangeReviewStep) => !step.removed && !stepIsSeen(step);
  const after = review.steps.findIndex((step, index) => index > from && unanswered(step));
  const anywhere = after !== -1 ? after : review.steps.findIndex(unanswered);
  return anywhere === -1 ? "recap" : anywhere;
}

/** The nearest step still in the review after (`1`) or before (`-1`) `from`, none when there is no more. */
function neighbour(review: ChangeReview, from: number, direction: 1 | -1): number | undefined {
  for (let index = from + direction; index >= 0 && index < review.steps.length; index += direction) if (!review.steps[index]!.removed) return index;
  return undefined;
}

/** "Étape n" of a step: removed steps are not counted, and a removed one takes the number of the step that follows it. */
function stepNumber(review: ChangeReview, index: number): number {
  const kept = review.steps.slice(0, index + 1).filter((step) => !step.removed).length;
  return Math.min(review.steps[index]!.removed ? kept + 1 : kept, Math.max(activeSteps(review.steps).length, 1));
}

const stepRoute = (reviewId: string, view: View): Route => ({ name: "review", reviewId, step: view === "recap" ? "recap" : view + 1 });

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

/** The review mode: a variant of Present limited to the steps Claude declared, with its own red identity. */
export function ReviewScreen({ reviewId, step }: { reviewId: string; step?: number | "recap" }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /** The last review shown, so a failed reload still names it in the header. */
  const lastReview = useRef<ChangeReview>();
  const [failed, setFailed] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | undefined>();
  const controlsOf = useReviewControls();
  const [confirming, setConfirming] = useState<{ notSeen: number; present: ChangeReviewPresence[] } | undefined>();
  const [filing, setFiling] = useState(false);
  const [removed, setRemoved] = useState<RemovedRemark | undefined>();
  /** The artboard of each group step on the stage: the index in its others, none for the example. Local to this screen. */
  const [opened, setOpened] = useState<Record<string, number | undefined>>({});
  const removedTimer = useRef<ReturnType<typeof setTimeout>>();

  // A remark Redline has not received: closing the tab asks first, and so does leaving the step.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  /** Loads the review as it stands now and answers it (undefined when it cannot be shown). */
  const reload = useCallback(async (): Promise<ChangeReview | undefined> => {
    try {
      const response = await fetch(reviewPath(reviewId));
      if (response.status === 404) setLoad({ status: "missing" });
      else if (response.status === 403) setLoad({ status: "refused" });
      else if (!response.ok) setLoad({ status: "error" });
      else {
        const next = (await response.json()) as ChangeReview;
        setLoad({ status: "ready", review: next });
        return next;
      }
    } catch {
      setLoad({ status: "error" });
    }
    return undefined;
  }, [reviewId]);
  useEffect(() => void reload(), [reload]);
  // Another member's answer, or the review's end, shows here at once.
  useEffect(
    () =>
      subscribeServerEvents((event) => {
        if (event.type === "review-updated" && event.reviewId === reviewId) void reload();
      }, () => void reload()),
    [reviewId, reload],
  );

  const review = load.status === "ready" ? load.review : undefined;

  // The others see who is in the review (for the confirmation before finishing): a heartbeat with the step shown, until the review is locked or the screen closes.
  const reviewIsOpen = review?.state === "open";
  const presenceStep = typeof step === "number" ? step : undefined;
  useEffect(() => {
    if (!reviewIsOpen) return;
    const beat = () => void fetch(`${reviewPath(reviewId)}/presence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(presenceStep === undefined ? {} : { step: presenceStep }) }).catch(() => undefined);
    beat();
    const timer = setInterval(beat, PRESENCE_BEAT_MS);
    return () => clearInterval(timer);
  }, [reviewId, reviewIsOpen, presenceStep]);
  useEffect(() => {
    if (!reviewIsOpen) return;
    return () => void fetch(`${reviewPath(reviewId)}/presence`, { method: "DELETE", keepalive: true }).catch(() => undefined);
  }, [reviewId, reviewIsOpen]);

  // The address names the step as soon as the review shows, so answering never moves the member to another one.
  useEffect(() => {
    if (review && step === undefined) navigateTo(stepRoute(reviewId, review.state !== "open" ? "recap" : nextUnanswered(review, -1)), "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.id, step]);
  useDocumentTitle(review ? `Revue · ${review.projectTitle}` : "Revue");

  /** Sends one change of the member's answer; the answer is the review as it stands then. */
  async function change(method: "PUT" | "DELETE" | "POST", path: string, body?: unknown): Promise<ChangeReview | undefined> {
    setFailed(false);
    const response = await fetch(`${reviewPath(reviewId)}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }).catch(() => undefined);
    if (!response?.ok) {
      setFailed(true);
      // A 409 means the review was locked meanwhile: show it as it is.
      if (response?.status === 409) void reload();
      return undefined;
    }
    const next = (await response.json()) as ChangeReview;
    setLoad({ status: "ready", review: next });
    return next;
  }

  if (load.status !== "ready") return <StateScreen status={load.status} review={lastReview.current} onRetry={() => void reload()} />;
  lastReview.current = review;
  const hasRemarks = review!.steps.some((entry) => entry.answers.some((answer) => answer.kind === "remark"));
  if (activeSteps(review!.steps).length === 0 && !hasRemarks && (review!.state === "open" || review!.state === "filed")) return <StateScreen status="empty" review={review} onRetry={() => void reload()} />;
  const view: View = step === undefined ? (review!.state !== "open" ? "recap" : nextUnanswered(review!, -1)) : step === "recap" || step > review!.steps.length ? "recap" : step - 1;
  const shownOf = (step: ChangeReviewStep) => shownStep(step, opened[step.id]);
  const guard = (action: () => void) => (unsaved ? setLeaving(() => action) : action());
  const navigate = (target: View) => navigateTo(stepRoute(reviewId, target), "replace");
  const go = (target: View) => guard(() => navigate(target));

  const answerOk = async (index: number) => {
    const next = await change("PUT", `/steps/${review!.steps[index]!.id}/ok`);
    if (next) navigate(nextUnanswered(next, index));
  };
  const clearRemarkAndValidate = async (index: number) => {
    const step = review!.steps[index]!;
    const remarkId = step.answers.find((answer) => answer.mine && answer.kind === "remark")?.id;
    if (remarkId && !(await change("DELETE", `/remarks/${remarkId}`))) return;
    await answerOk(index);
  };
  const cancelOk = (index: number) => void change("DELETE", `/steps/${review!.steps[index]!.id}/ok`);
  const finish = () => {
    setConfirming(undefined);
    void change("POST", "/finish").then((next) => next && navigate("recap"));
  };
  // Asks before finishing when steps were not seen or another member is still in the review; the presence is read fresh.
  const requestFinish = () =>
    guard(() => {
      void reload().then((fresh) => {
        if (!fresh) return;
        if (fresh.state !== "open") return navigate("recap");
        const notSeen = activeSteps(fresh.steps).filter((entry) => !stepIsSeen(entry)).length;
        if (notSeen > 0 || fresh.present.length > 0) setConfirming({ notSeen, present: fresh.present });
        else finish();
      });
    });
  const reopen = () => void change("POST", "/reopen");
  const file = () => {
    setFiling(false);
    void change("POST", "/file");
  };
  const removeRemark = (answerId: string, stepId: string, text: string, title: string) => {
    clearTimeout(removedTimer.current);
    void change("DELETE", `/remarks/${answerId}`).then((next) => {
      if (!next) return;
      setRemoved({ stepId, text, title });
      removedTimer.current = setTimeout(() => setRemoved(undefined), UNDO_REMOVAL_MS);
    });
  };
  const restoreRemark = async () => {
    if (!removed) return;
    clearTimeout(removedTimer.current);
    const next = await change("PUT", `/steps/${removed.stepId}/remark`, { text: removed.text });
    // The review was locked meanwhile: the text stays here, read-only.
    setRemoved(next ? undefined : { ...removed, lost: true });
  };

  return (
    <div data-testid="review" className={styles.review}>
      <TopBar review={review!} view={view} shown={view === "recap" || review!.steps[view]!.removed ? undefined : shownOf(review!.steps[view]!)} controls={view === "recap" || review!.steps[view]!.removed ? undefined : controlsOf(shownOf(review!.steps[view]!))} onGo={go} onLeave={guard} onFinish={requestFinish} />
      {view === "recap" ? (
        <Recap review={review!} failed={failed} removed={removed} onGo={go} onFinish={requestFinish} onReopen={reopen} onFile={() => setFiling(true)} onRemove={removeRemark} onRestore={() => void restoreRemark()} />
      ) : review!.steps[view]!.removed ? (
        <RemovedStep review={review!} index={view} onGo={go} />
      ) : (
        <StepView
          key={review!.steps[view]!.id}
          review={review!}
          index={view}
          controls={controlsOf(shownOf(review!.steps[view]!))}
          openedMember={opened[review!.steps[view]!.id]}
          onOpenMember={(member) => setOpened((current) => ({ ...current, [review!.steps[view]!.id]: member }))}
          failed={failed}
          onGo={go}
          onOk={() => guard(() => void answerOk(view))}
          onClearAndValidate={() => guard(() => void clearRemarkAndValidate(view))}
          onCancel={() => cancelOk(view)}
          onReopen={reopen}
          remark={{ reviewPath: reviewPath(reviewId), onReview: (next) => setLoad({ status: "ready", review: next }), onReload: () => void reload(), onUnsaved: setUnsaved }}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={confirming.notSeen > 0 ? `${counted(confirming.notSeen, "étape non vue", "étapes non vues")} : terminer quand même ?` : "Terminer la revue ?"}
          cancel="Continuer la revue"
          confirm="Terminer quand même"
          onCancel={() => setConfirming(undefined)}
          onConfirm={finish}
        >
          <p>
            {confirming.notSeen > 0
              ? "Elles seront signalées à part à la conversation comme « non vues », jamais comme validées. Plus personne ne pourra ajouter de remarque, sauf si un membre rouvre la revue."
              : "Plus personne ne pourra ajouter de remarque, sauf si un membre rouvre la revue."}
          </p>
          {confirming.present.length > 0 && <p>{presenceLine(confirming.present)}</p>}
        </ConfirmDialog>
      )}
      {filing && (
        <ConfirmDialog title="Classer sans envoyer ?" cancel="Annuler" confirm="Classer sans envoyer" onCancel={() => setFiling(false)} onConfirm={file}>
          <p>{filingWarning(review!)}</p>
        </ConfirmDialog>
      )}
      {leaving && (
        <LeaveDialog
          onStay={() => setLeaving(undefined)}
          onLeave={() => {
            const action = leaving;
            setLeaving(undefined);
            setUnsaved(false);
            action();
          }}
        />
      )}
    </div>
  );
}

/** "Victor est encore dans la revue (étape 6)." / "Victor et Ariane sont encore dans la revue." */
function presenceLine(present: ChangeReviewPresence[]): ReactNode {
  const names = present.map((entry) => personName(entry.person));
  const where = present.length === 1 && present[0]!.step !== undefined ? ` (étape ${present[0]!.step})` : "";
  return (
    <>
      <span className={styles.who}>
        {names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`} {names.length === 1 ? "est" : "sont"} encore dans la revue
      </span>
      {where}.
    </>
  );
}

/** What filing throws away: the remarks that were never sent, with whose they are. */
function filingWarning(review: ChangeReview): string {
  const remarks = review.steps.flatMap((entry) => entry.answers.filter((answer) => answer.kind === "remark"));
  const final = "C'est définitif : la revue ne pourra plus être rouverte.";
  if (remarks.length === 0) return `Cette revue n'a aucune remarque, mais elle ne sera jamais transmise à une conversation. ${final}`;
  if (remarks.length === 1) return `${remarks[0]!.mine ? "Ta remarque" : `La remarque de ${personName(remarks[0]!.person)}`} ne sera jamais transmise à une conversation. ${final}`;
  const others = remarks.filter((answer) => !answer.mine);
  const names = [...new Set(others.map((answer) => personName(answer.person)))];
  const whose = others.length === 0 ? "" : ` (dont ${others.length === 1 ? "celle" : "celles"} de ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`})`;
  return `Les ${remarks.length} remarques${whose} ne seront jamais transmises à une conversation. ${final}`;
}

const STATE_TEXTS = {
  missing: { title: "Revue introuvable", detail: "Ce lien ne correspond à aucune revue : il est incomplet, ou le projet a été supprimé. Le lien d'une revue classée ouvre toujours son récapitulatif." },
  refused: {
    title: "Revue réservée aux membres de l'équipe en Écriture",
    detail: "Ton accès à cette page (membre en Lecture ou Commentaire, ou lien de partage) ne permet pas de participer à la revue. Tu peux toujours commenter les artboards depuis le canvas si ton accès le permet.",
  },
  error: { title: "La revue n'a pas pu se charger", detail: "Le serveur Redline ne répond pas. Tes OK et tes remarques déjà faits sont enregistrés." },
} as const;

/** "Les 9 artboards de cette revue ont été supprimés depuis la demande." */
function emptyDetail(review: ChangeReview): string {
  const count = review.steps.length;
  const verb = review.steps.every((entry) => entry.removed === "deleted") ? "supprimé" : "supprimé ou archivé";
  const lead = count > 1 ? `Les ${count} artboards de cette revue ont été ${verb}s` : `L'artboard de cette revue a été ${verb}`;
  return `${lead} depuis la demande. Demande à Claude de refaire la revue si besoin.`;
}

/** The screens with nothing to review: loading, error (the title of the last review shown stays), empty, refused, not found. */
function StateScreen({ status, review, onRetry }: { status: Exclude<Load["status"], "ready"> | "empty"; review?: ChangeReview; onRetry: () => void }) {
  const text = status === "loading" ? undefined : status === "empty" ? { title: "Plus rien à revoir", detail: emptyDetail(review!) } : STATE_TEXTS[status];
  const toCanvas = () => navigateTo(review ? { name: "project", projectId: review.projectId } : { name: "home" });
  const requester = review?.requester.person;
  const place = review ? (review.requester.label ?? review.requester.folder.split(/[\\/]/).filter(Boolean).pop() ?? review.requester.folder) : "";
  return (
    <div data-testid="review" className={styles.review}>
      <header data-testid="review-top" className={styles.top}>
        <div className={styles.lead}>
          <button type="button" className={styles.button} onClick={() => navigateTo({ name: "home" })}>
            ← Canvas
          </button>
          <span className={styles.mode}>Revue</span>
          {review && (status === "error" || status === "empty") && (
            <span data-testid="review-title" className={styles.title}>
              Revue{requester ? <> de <strong>{personName(requester)}</strong></> : ""} · {place} · {review.projectTitle}
            </span>
          )}
        </div>
      </header>
      <div className={styles.stateScreen}>
        {text ? (
          <div className={styles.stateBox} role={status === "error" ? "alert" : undefined}>
            <h1>{text.title}</h1>
            <p>{text.detail}</p>
            <div className={styles.stateActions}>
              {status === "error" && (
                <button type="button" className={cx(styles.stateButton, styles.stateButtonLight)} onClick={onRetry}>
                  Réessayer
                </button>
              )}
              <button type="button" className={styles.stateButton} onClick={toCanvas}>
                {status === "missing" ? "Retour au projet" : "Retour au canvas"}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.stateBox} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <p>Chargement de la revue</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** A step whose artboard was deleted, or whose page is archived: nothing to review, and it is not counted. */
function RemovedStep({ review, index, onGo }: { review: ChangeReview; index: number; onGo: (view: View) => void }) {
  const step = review.steps[index]!;
  const title = `${step.pageTitle} · ${step.artboardTitle}`;
  const next = neighbour(review, index, 1);
  const deleted = step.removed === "deleted";
  return (
    <div className={styles.stateScreen}>
      <div className={styles.stateBox} data-testid="review-removed">
        <h1>{deleted ? "Cet artboard n'existe plus" : "Cet artboard n'est plus disponible"}</h1>
        <p>
          {deleted
            ? `« ${title} » a été supprimé depuis la demande de revue. L'étape est retirée du compte.`
            : `« ${title} » est sur une page archivée. L'étape est retirée du compte${review.state === "open" ? " tant que la page n'est pas désarchivée." : "."}`}
        </p>
        <div className={styles.stateActions}>
          <button type="button" className={cx(styles.stateButton, styles.stateButtonLight)} onClick={() => onGo(next ?? "recap")}>
            {next === undefined ? "Récapitulatif →" : "Étape suivante →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Desktop", or "Desktop · 1440" when the artboard has several renderings of the same format. */
const renderingOptionLabel = (renderings: ArtboardRendering[], rendering: ArtboardRendering) =>
  renderings.filter((other) => other.format === rendering.format).length > 1 ? renderingLabel(rendering) : RESPONSIVE_FORMATS[rendering.format].label;

function TopBar({ review, view, shown, controls, onGo, onLeave, onFinish }: { review: ChangeReview; view: View; shown?: ChangeReviewStep; controls?: StepControls; onGo: (view: View) => void; onLeave: (action: () => void) => void; onFinish: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const total = activeSteps(review.steps).length;
  const previous = view === "recap" ? undefined : neighbour(review, view, -1);
  const next = view === "recap" ? undefined : neighbour(review, view, 1);
  const step = shown;
  const requester = review.requester.person;
  const place = review.requester.label ?? review.requester.folder.split(/[\\/]/).filter(Boolean).pop() ?? review.requester.folder;
  const backTo: Route = view === "recap" || review.steps[view]!.removed ? { name: "project", projectId: review.projectId } : { name: "page", pageId: review.steps[view]!.pageId };
  // A group spanning several pages is listed apart, under "Sur plusieurs pages" (they come last in the review).
  const groups = review.steps.reduce<{ key: string; title: string; entries: { step: ChangeReviewStep; index: number }[] }[]>((acc, entryStep, index) => {
    if (entryStep.removed) return acc;
    const multi = stepIsMultiPage(entryStep);
    const key = multi ? "" : entryStep.pageId;
    const last = acc[acc.length - 1];
    if (last && last.key === key) last.entries.push({ step: entryStep, index });
    else acc.push({ key, title: multi ? "Sur plusieurs pages" : entryStep.pageTitle, entries: [{ step: entryStep, index }] });
    return acc;
  }, []);

  return (
    <header data-testid="review-top" className={styles.top}>
      <div className={styles.lead}>
        <button type="button" className={styles.button} onClick={() => onLeave(() => navigateTo(backTo))}>
          ← Canvas
        </button>
        <span className={styles.mode}>Revue</span>
        <span data-testid="review-title" className={styles.title}>
          Revue{requester ? <> de <strong>{personName(requester)}</strong></> : ""} · {place} · {review.projectTitle}
        </span>
      </div>
      <div ref={menu} className={styles.counterWrap}>
        {view !== "recap" && (
          <button type="button" className={styles.button} aria-label="Étape précédente" disabled={previous === undefined} onClick={() => onGo(previous!)}>
            ←
          </button>
        )}
        <button type="button" className={styles.counter} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          {view === "recap" ? "Récapitulatif" : `Étape ${stepNumber(review, view)} / ${total}`}
          {view === "recap" && review.state === "open" && <small className={styles.counterSmall}>· {progressOf(review.steps, -1).seen} / {total} vus</small>}
          <span className={styles.chev} aria-hidden="true">
            ▼
          </span>
        </button>
        {view !== "recap" && (
          <button type="button" className={styles.button} aria-label="Étape suivante" onClick={() => onGo(next ?? "recap")}>
            →
          </button>
        )}
        {menuOpen && (
          <div role="menu" aria-label="Étapes de la revue" className={styles.menu}>
            {groups.map((group) => (
              <div key={group.key || "multi"}>
                <h4>{group.title}</h4>
                {group.entries.map(({ step, index }) => (
                  <button
                    key={step.id}
                    type="button"
                    role="menuitem"
                    className={cx(styles.menuItem, index === view && styles.menuItemCurrent)}
                    onClick={() => {
                      setMenuOpen(false);
                      onGo(index);
                    }}
                  >
                    <span className={styles.menuNumber}>{stepNumber(review, index)}</span>
                    <span className={cx(styles.dot, stepDotClass(step), index === view && styles.dotCurrent)} />
                    <span className={styles.menuTitle}>{stepLabel(step)}</span>
                    <span className={styles.menuState}>{index === view ? "En cours" : stepIsModified(step) ? "Modifié" : STATUS_LABEL[stepStatus(step.answers)]}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.trail}>
        {controls && step && !step.removed && (step.baselineVersionId || step.isNew) && (
          <div role="group" aria-label="Version" className={styles.seg}>
            <button
              type="button"
              aria-pressed={controls.showBefore}
              disabled={step.isNew}
              title={step.isNew ? "Nouveau, pas d'avant" : undefined}
              className={cx(styles.segButton, controls.showBefore && styles.segButtonOn)}
              onClick={() => controls.chooseBefore(true)}
            >
              Avant
            </button>
            <button type="button" aria-pressed={!controls.showBefore} className={cx(styles.segButton, !controls.showBefore && styles.segButtonOn)} onClick={() => controls.chooseBefore(false)}>
              Après{step.isNew ? " (nouveau)" : ""}
            </button>
          </div>
        )}
        {controls && controls.renderings.length > 0 && (
          <div role="group" aria-label="Rendu" className={styles.seg}>
            {controls.renderings.map((rendering) => (
              <button
                key={renderingKey(rendering)}
                type="button"
                aria-pressed={rendering === controls.rendering}
                className={cx(styles.segButton, rendering === controls.rendering && styles.segButtonOn)}
                onClick={() => controls.chooseRendering(rendering)}
              >
                {renderingOptionLabel(controls.renderings, rendering)}
              </button>
            ))}
          </div>
        )}
        {controls && controls.tweaks.length > 0 && (
          <button type="button" aria-pressed={controls.tweaksOpen} className={cx(styles.button, controls.tweaksOpen && styles.buttonOn)} onClick={controls.toggleTweaks}>
            Tweaks
          </button>
        )}
        {review.state === "open" && view !== "recap" && (
          <button type="button" className={cx(styles.button, styles.buttonLight)} onClick={onFinish}>
            Terminer la revue
          </button>
        )}
      </div>
    </header>
  );
}

const STATUS_LABEL = { unseen: "Non vu", ok: "OK", remark: "Remarque" } as const;

const stepDotClass = (step: ChangeReviewStep) => (stepIsModified(step) ? styles.dotChanged : stepStatus(step.answers) === "ok" ? styles.dotOk : stepStatus(step.answers) === "remark" ? styles.dotRemark : undefined);

function Progress({ review, index }: { review: ChangeReview; index: number }) {
  const { seen, total, segments } = progressOf(review.steps, index);
  return (
    <div data-testid="review-progress" className={styles.progress} aria-label="Progression de la revue">
      <div className={styles.progressHead}>
        <span>Progression</span>
        <strong>
          {seen} / {total} vus
        </strong>
      </div>
      <div className={styles.progressBar}>
        {segments.map((segment, position) => (
          <i key={activeSteps(review.steps)[position]!.id} className={cx(styles.segment, segment === "ok" && styles.segmentOk, segment === "remark" && styles.segmentRemark, segment === "current" && styles.segmentCurrent, segment === "modified" && styles.segmentChanged)} />
        ))}
      </div>
    </div>
  );
}

type RemarkProps = { reviewPath: string; onReview: (review: ChangeReview) => void; onReload: () => void; onUnsaved: (unsaved: boolean) => void };

function StepView({
  review,
  index,
  controls,
  openedMember,
  onOpenMember,
  failed,
  onGo,
  onOk,
  onClearAndValidate,
  onCancel,
  onReopen,
  remark,
}: {
  review: ChangeReview;
  index: number;
  controls: StepControls;
  openedMember: number | undefined;
  onOpenMember: (member: number | undefined) => void;
  failed: boolean;
  onGo: (view: View) => void;
  onOk: () => void;
  onClearAndValidate: () => void;
  onCancel: () => void;
  onReopen: () => void;
  remark: RemarkProps;
}) {
  const step = review.steps[index]!;
  const own = step.answers.find((answer) => answer.mine);
  const others = step.answers.filter((answer) => !answer.mine);
  const status = stepStatus(step.answers);
  const finished = review.state !== "open";
  const [keptUnsaved, setKeptUnsaved] = useState(false);
  // The member's own answer saw an older version of the artboard.
  const modified = stepIsModified(step) || own?.outdated === true;
  const group = stepIsGroup(step);
  const shown = shownStep(step, openedMember);
  const size = group ? step.others!.length + 1 : 1;
  const pageCount = new Set([step.pageId, ...(step.others ?? []).map((member) => member.pageId)]).size;
  const changedNames = (step.others ?? []).filter((member) => member.modified).map((member) => `${member.pageTitle} · ${member.artboardTitle}`);
  const exampleChanged = step.modifiedAt !== undefined ? [`${step.pageTitle} · ${step.artboardTitle}`] : [];
  const changedSince = [...exampleChanged, ...changedNames];
  return (
    <div className={styles.body}>
      <ReviewStage review={review} step={shown} example={step} modified={modified && (!group || shown.modifiedAt !== undefined)} controls={controls} openedMember={openedMember} onOpenMember={onOpenMember} />
      <aside aria-label="Question de l'étape" className={styles.panel}>
        <div className={styles.panelScroll}>
          <Progress review={review} index={index} />
          <div>
            <div className={cx(styles.kicker, group && styles.kickerGroup)}>
              <span>
                {group ? `${counted(pageCount, "page", "pages")} · ${size} artboards` : `Page ${step.pageTitle} · étape ${stepNumber(review, index)} / ${activeSteps(review.steps).length}`}
              </span>
              <span className={styles.chips}>
                {group && <span className={styles.chip}>Groupé</span>}
                <span className={cx(styles.chip, !finished && !modified && status === "ok" && styles.chipOk, !finished && !modified && status === "remark" && styles.chipRemark, !finished && modified && styles.chipChanged)}>
                  {finished ? "Lecture seule" : modified ? "Modifié depuis ta revue" : status === "ok" ? "✓ OK" : STATUS_LABEL[status]}
                </span>
              </span>
            </div>
            <h2 className={styles.heading}>{stepLabel(step)}</h2>
          </div>
          <section className={styles.section}>
            <h3>Ce qui a changé</h3>
            <p>{step.changed}</p>
          </section>
          <section className={styles.section}>
            <h3>Quoi regarder</h3>
            <p>
              {step.mobile && (
                <>
                  <strong>À regarder en mobile</strong> :{" "}
                </>
              )}
              {step.lookAt}
            </p>
            {step.tweaks && Object.keys(step.tweaks).length > 0 && <p className={styles.hint}>État affiché : « {stateShown(step, controls.tweaks)} », fixé par Claude. Les autres états restent dans Tweaks.</p>}
          </section>
          <div className={styles.question}>
            <p>{step.question}</p>
            {!finished && (
              <div className={styles.row}>
                {own?.outdated && own.kind === "remark" ? (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onClearAndValidate}>
                    Effacer ma remarque et valider
                  </button>
                ) : own?.outdated ? (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onOk}>
                    {group ? `Revoir et valider les ${size}` : "Revoir et valider"}
                  </button>
                ) : own?.kind === "remark" ? (
                  <span className={styles.hint}>Ta remarque remplace ton OK pour cette étape.</span>
                ) : own ? (
                  <button type="button" className={styles.panelButton} onClick={onCancel}>
                    ✓ Validé par toi · annuler
                  </button>
                ) : (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onOk}>
                    {group ? `OK pour les ${size}` : "OK, étape suivante"}
                  </button>
                )}
              </div>
            )}
            {group && !finished && own?.outdated && own.kind === "ok" && changedSince.length > 0 && (
              <span className={styles.hint}>
                Ton OK du {formatWhen(own.at)} ne compte plus : {changedSince.map((name) => `« ${name} »`).join(", ")} {changedSince.length > 1 ? "ont" : "a"} changé depuis.
              </span>
            )}
            {failed && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>}
          </div>
          {others.length > 0 && (
            <section className={styles.section}>
              <h3>Les autres</h3>
              {others.map((answer) => (
                <div key={answer.id} className={styles.other}>
                  <PersonDot person={answer.person} />
                  <span className={styles.otherText}>
                    <strong>{personName(answer.person)}</strong> · {answer.kind === "ok" ? (answer.outdated ? "Validé (ancienne version)" : "✓ Validé") : answer.text}
                  </span>
                </div>
              ))}
            </section>
          )}
          {finished && (
            <div className={styles.lock}>
              <span>
                <strong>{lockTitle(review)}</strong>
                {lockWhen(review)} : plus de OK ni de remarque.{keptUnsaved ? " Ton texte non enregistré est gardé ci-dessous pour que tu le copies." : ""}
              </span>
              {review.state === "finished" && (
                <button type="button" className={styles.panelButton} style={{ flex: "0 0 auto" }} onClick={onReopen}>
                  Rouvrir la revue
                </button>
              )}
            </div>
          )}
          <RemarkEditor stepId={step.id} own={own} finished={finished} onKeptUnsaved={setKeptUnsaved} placement={group ? { shown: { pageId: shown.pageId, artboard: shown.artboard }, example: { pageId: step.pageId, artboard: step.artboard }, titleOf: (ref) => titleOfArtboard(step, ref) } : undefined} {...remark} />
        </div>
        <div className={styles.panelFoot}>
          <button type="button" className={styles.panelButton} disabled={neighbour(review, index, -1) === undefined} onClick={() => onGo(neighbour(review, index, -1)!)}>
            ← Précédente
          </button>
          <button type="button" className={styles.panelButton} onClick={() => onGo(neighbour(review, index, 1) ?? "recap")}>
            Suivante →
          </button>
        </div>
      </aside>
    </div>
  );
}

/** The step as the top bar and the stage show it: the example, or the artboard of the group whose thumbnail was opened (its own fields; the example's tweak values and group do not apply to it). */
function shownStep(step: ChangeReviewStep, member: number | undefined): ChangeReviewStep {
  const other = member === undefined ? undefined : step.others?.[member];
  if (!other) return step;
  return {
    ...step,
    id: `${step.id}#${member}`,
    others: undefined,
    tweaks: undefined,
    pageId: other.pageId,
    artboard: other.artboard,
    pageTitle: other.pageTitle,
    artboardTitle: other.artboardTitle,
    artboardEntry: other.artboardEntry,
    artboardTweaks: other.artboardTweaks,
    savedTweaks: other.savedTweaks,
    baselineVersionId: other.baselineVersionId,
    baselineAt: other.baselineAt,
    isNew: other.isNew,
    modifiedBy: other.modifiedBy,
    modifiedAt: other.modifiedAt,
  };
}

/** "Page · artboard" of an artboard of the step. */
function titleOfArtboard(step: ChangeReviewStep, ref: ArtboardRef): string {
  const member = step.others?.find((other) => other.pageId === ref.pageId && other.artboard === ref.artboard);
  return member ? `${member.pageTitle} · ${member.artboardTitle}` : `${step.pageTitle} · ${step.artboardTitle}`;
}

/** The values Claude set for the step, named by their tweak labels: "État : sommaire, Dense : oui". */
function stateShown(step: ChangeReviewStep, tweaks: StepControls["tweaks"]): string {
  const shown = (value: TweakValues[string]) => (typeof value === "boolean" ? (value ? "oui" : "non") : String(value));
  return Object.entries(step.tweaks ?? {})
    .map(([id, value]) => `${tweaks.find((tweak) => tweak.id === id)?.label ?? id} : ${shown(value)}`)
    .join(", ");
}

/** What a device frame draws outside the viewport (a shadow ring), which the stage padding does not count. */
const DEVICE_BEZEL: Partial<Record<string, number>> = { phone: 10, tablet: 14 };

/** The artboard of the step at full size, in the same frame and fit as Present, with the Tweaks panel over its right side. */
function ReviewStage({
  review,
  step,
  example,
  modified,
  controls,
  openedMember,
  onOpenMember,
}: {
  review: ChangeReview;
  /** What the stage shows: the step, or the artboard of its group that was opened. */
  step: ChangeReviewStep;
  example: ChangeReviewStep;
  modified: boolean;
  controls: StepControls;
  openedMember: number | undefined;
  onOpenMember: (member: number | undefined) => void;
}) {
  const origin = useArtboardOrigin(review.projectId);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const frame = useRef<HTMLIFrameElement>(null);
  const [bridgeEpoch, setBridgeEpoch] = useState(0);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && (event.data as { type?: string }).type === "redline:ready") setBridgeEpoch((epoch) => epoch + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (bridgeEpoch > 0) frame.current?.contentWindow?.postMessage({ type: "redline:set-tweaks", values: controls.values }, "*");
  }, [controls.values, bridgeEpoch]);
  const entry = step.artboardEntry;
  /** The stage's own padding keeps the artboard off its edges, so the fit takes the space inside it. */
  const shown = entry && presentationOf(entry, true, windowWidth, entry.responsive ? controls.rendering : undefined);
  const presentation = shown && { ...shown, stagePadding: DEVICE_BEZEL[shown.frame] ?? 0 };
  const fitted = presentation && fitToStage(presentation, size);
  return (
    <main className={cx(styles.stage, stepIsGroup(example) && styles.stageGroup, controls.tweaksOpen && controls.tweaks.length > 0 && styles.stageTweaks)}>
      {controls.showBefore && step.baselineAt && (
        <span data-testid="review-before-tag" className={styles.tag}>
          Avant · version du {formatWhen(step.baselineAt)}, avant la série
        </span>
      )}
      {modified && !controls.showBefore && (
        <span data-testid="review-modified-tag" className={styles.tag}>
          Nouvelle version{step.modifiedBy ? ` de ${step.modifiedBy}` : ""} depuis ta revue{step.modifiedAt ? ` · ${relativeTime(step.modifiedAt)}` : ""}
        </span>
      )}
      <div ref={stage} className={styles.shotArea}>
        {entry && presentation && fitted && origin ? (
          <PlayFrame frame={presentation.frame} url={entry.url}>
            <div className={styles.viewport} style={{ width: fitted.viewport.width * fitted.scale, height: fitted.viewport.height * fitted.scale }}>
              <ArtboardIframe
                ref={frame}
                title={`Revue / ${step.artboard}`}
                src={controls.showBefore && step.baselineVersionId ? `${origin}${versionPreviewPath(step.pageId, step.baselineVersionId, step.artboard)}` : `${origin}/pages/${step.pageId}/${step.artboard}`}
                sandbox="allow-scripts"
                className={styles.frame}
                style={{ width: fitted.viewport.width, height: fitted.viewport.height, transform: `scale(${fitted.scale})` }}
              />
            </div>
          </PlayFrame>
        ) : entry ? null : (
          <p className={styles.hint}>Cet artboard n'existe plus · {step.artboard}</p>
        )}
      </div>
      {stepIsGroup(example) && <GroupThumbnails example={example} origin={origin} openedMember={openedMember} onOpenMember={onOpenMember} />}
      {controls.tweaksOpen && controls.tweaks.length > 0 && (
        <aside aria-label="Tweaks" className={styles.tweaks}>
          <div className={styles.tweaksHead}>
            <strong>Tweaks</strong>
            <span>Ces réglages restent dans ta revue : rien n'est enregistré sur la page.</span>
          </div>
          <TweaksPanel theme="dark" tweaks={controls.tweaks} values={controls.values} onChange={controls.setValue} previews={entry && origin ? { pageId: step.pageId, artboardOrigin: origin, artboard: entry } : undefined} />
        </aside>
      )}
    </main>
  );
}

/** The thumbnails shown before "+ N autres" (two rows of four, the last cell being the "+ N autres" tile). */
const THUMBNAILS_SHOWN = 7;

/** The other artboards of a group as clickable thumbnails: a click shows one large, "Revenir à l'exemple" goes back. */
function GroupThumbnails({ example, origin, openedMember, onOpenMember }: { example: ChangeReviewStep; origin: string; openedMember: number | undefined; onOpenMember: (member: number | undefined) => void }) {
  const [all, setAll] = useState(false);
  const members = example.others!;
  const hidden = !all && members.length > THUMBNAILS_SHOWN + 1 ? members.length - THUMBNAILS_SHOWN : 0;
  const shown = members.map((member, index) => ({ member, index })).slice(0, hidden > 0 ? THUMBNAILS_SHOWN : members.length);
  const openedTitle = openedMember === undefined ? undefined : `${members[openedMember]!.pageTitle} · ${members[openedMember]!.artboardTitle}`;
  return (
    <section data-testid="review-others" className={styles.others}>
      <div className={styles.othersHead}>
        <h3>
          {openedTitle
            ? `Affiché : ${openedTitle}`
            : `Exemple : ${example.pageTitle} · ${example.artboardTitle}. Même changement sur ${members.length} autre${members.length > 1 ? "s" : ""} artboard${members.length > 1 ? "s" : ""} (un clic l'affiche en grand)`}
        </h3>
        {openedTitle && (
          <button type="button" className={cx(styles.panelButton, styles.backToExample)} onClick={() => onOpenMember(undefined)}>
            Revenir à l'exemple
          </button>
        )}
      </div>
      <div className={styles.grid}>
        {shown.map(({ member, index }) => (
          <button
            key={`${member.pageId}/${member.artboard}`}
            type="button"
            aria-pressed={index === openedMember}
            title={`${member.pageTitle} · ${member.artboardTitle}`}
            className={cx(styles.thumb, index === openedMember && styles.thumbOpened)}
            onClick={() => onOpenMember(index)}
          >
            <Thumbnail member={member} origin={origin} />
            <span>
              {member.pageTitle} · {member.artboardTitle}
            </span>
            {member.modified && <span className={cx(styles.chip, styles.chipChanged, styles.thumbChip)}>Modifié depuis ta revue</span>}
          </button>
        ))}
        {hidden > 0 && (
          <button type="button" className={styles.thumb} onClick={() => setAll(true)}>
            <span className={styles.thumbPreview} />
            <span>+ {hidden} autres</span>
          </button>
        )}
      </div>
    </section>
  );
}

/** A live, scaled and inert view of the artboard in a 16:9 box. */
function Thumbnail({ member, origin }: { member: ChangeReviewMember; origin: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const entry = member.artboardEntry;
  const size = entry && (entry.responsive?.[0] ?? entry);
  const scale = size && width > 0 ? Math.min(width / size.width, (width * 9) / 16 / size.height) : 0;
  return (
    <span ref={box} className={styles.thumbPreview}>
      {size && origin && scale > 0 && (
        <ArtboardIframe
          title={`Miniature / ${member.artboard}`}
          src={`${origin}/pages/${member.pageId}/${member.artboard}`}
          sandbox="allow-scripts"
          loading="lazy"
          tabIndex={-1}
          aria-hidden="true"
          className={styles.thumbFrame}
          style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
        />
      )}
    </span>
  );
}

const nameOfAnswer = (answer: ChangeReviewAnswer, own: string) => (answer.mine ? own : personName(answer.person));

const placeOf = (review: ChangeReview) => review.requester.label ?? review.requester.folder.split(/[\\/]/).filter(Boolean).pop() ?? review.requester.folder;

/** "Terminée par X", "Récupérée par la conversation de X", "Classée sans envoi par X": who locked the review. */
function lockTitle(review: ChangeReview): string {
  if (review.state === "fetched") return `Récupérée par la conversation de ${personName(review.fetchedBy)}`;
  if (review.state === "filed") return `Classée sans envoi par ${personName(review.filedBy)}`;
  return `Terminée par ${personName(review.finishedBy)}`;
}

const lockWhen = (review: ChangeReview): string => {
  const at = review.state === "fetched" ? review.fetchedAt : review.state === "filed" ? review.filedAt : review.finishedAt;
  return at ? ` le ${formatWhen(at)}` : "";
};

/** "Victor avait validé cette étape" next to a remark of someone else on a step several people looked at. */
function alsoValidated(step: ChangeReviewStep): string {
  const validators = step.answers.filter((answer) => answer.kind === "ok" && !answer.outdated);
  if (validators.length === 0) return "";
  if (validators.length === 1) return validators[0]!.mine ? " · tu avais validé cette étape" : ` · ${personName(validators[0]!.person)} avait validé cette étape`;
  return ` · ${validators.map((answer) => nameOfAnswer(answer, "toi")).join(" et ")} avaient validé cette étape`;
}

function Recap({
  review,
  failed,
  removed,
  onGo,
  onFinish,
  onReopen,
  onFile,
  onRemove,
  onRestore,
}: {
  review: ChangeReview;
  failed: boolean;
  removed: RemovedRemark | undefined;
  onGo: (view: View) => void;
  onFinish: () => void;
  onReopen: () => void;
  onFile: () => void;
  onRemove: (answerId: string, stepId: string, text: string, title: string) => void;
  onRestore: () => void;
}) {
  const open = review.state === "open";
  const kept = activeSteps(review.steps);
  const okSteps = kept.filter((step) => stepStatus(step.answers) === "ok");
  const remarks = review.steps.flatMap((step) => step.answers.filter((answer) => answer.kind === "remark").map((answer) => ({ step, answer })));
  const notSeen = kept.filter((step) => !stepIsSeen(step));
  const titleOf = stepLabel;
  const indexOf = (step: ChangeReviewStep) => review.steps.indexOf(step);
  const place = placeOf(review);
  const requester = personName(review.requester.person);
  return (
    <div className={styles.screen}>
      <div className={styles.recap}>
        <div className={styles.recapSide}>
          <div className={cx(styles.recapHead, !open && styles.recapHeadLocked)}>
            <h1>{open ? "Avant de terminer" : "Revue terminée"}</h1>
            {open && <p className={styles.recapNote}>Tant que la revue n'est pas terminée, chacun peut encore changer ses remarques.</p>}
            {review.state === "finished" && (
              <div className={styles.done}>
                <strong>
                  {lockTitle(review)} · {review.finishedAt ? formatWhen(review.finishedAt) : ""}
                </strong>
                <span>
                  {review.viewerIsRequester ? "Dis maintenant à ta conversation" : `${requester} peut maintenant dire à sa conversation`} <span className={styles.quote}>{place}</span> que{" "}
                  {review.viewerIsRequester ? "tes retours sont prêts (par exemple « j'ai fait mes retours »)" : "les retours sont prêts"} : elle viendra les chercher. Rien n'est envoyé avant.
                </span>
              </div>
            )}
            {review.state === "fetched" && (
              <div className={styles.done}>
                <strong>
                  {lockTitle(review)} ({place}) · {review.fetchedAt ? formatWhen(review.fetchedAt) : ""}
                </strong>
                <span>
                  {remarks.length === 0 ? "" : remarks.length === 1 ? "La remarque est devenue un fil sur son artboard. " : `Les ${remarks.length} remarques sont devenues des fils sur leurs artboards. `}Cette revue reste lisible ici.
                </span>
              </div>
            )}
            {review.state === "filed" && (
              <div className={cx(styles.done, styles.doneNeutral)}>
                <strong>
                  {lockTitle(review)} · {review.filedAt ? formatWhen(review.filedAt) : ""}
                </strong>
                <span>Ces retours n'ont jamais été transmis à une conversation. La revue reste lisible ici et ne peut plus être rouverte.</span>
              </div>
            )}
          </div>
          <div className={styles.sum}>
            <div className={styles.sumCard}>
              <b>{okSteps.length}</b>
              <span>OK</span>
            </div>
            <div className={styles.sumCard}>
              <b>{remarks.length}</b>
              <span>{remarks.length > 1 ? "Remarques" : "Remarque"}</span>
            </div>
            <div className={styles.sumCard}>
              <b>{notSeen.length}</b>
              <span>Non vus</span>
            </div>
          </div>
          {open && (
            <div className={styles.recapFoot}>
              <button type="button" className={styles.panelButton} onClick={() => onGo(neighbour(review, review.steps.length, -1)!)} disabled={kept.length === 0}>
                ← Revenir aux étapes
              </button>
              <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onFinish}>
                Terminer la revue
              </button>
              {failed && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>}
            </div>
          )}
          {review.state === "finished" && (
            <div className={styles.twoButtons}>
              <button type="button" className={styles.panelButton} onClick={onReopen}>
                Rouvrir la revue
              </button>
              <button type="button" className={styles.panelButton} onClick={onFile}>
                Classer sans envoyer
              </button>
            </div>
          )}
          {(review.state === "fetched" || review.state === "filed") && <span className={styles.recapNote}>Lecture seule : retour au canvas par le bouton en haut à gauche.</span>}
          {failed && !open && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>}
          {removed && (
            <div className={removed.lost ? styles.lostText : styles.undoLine}>
              {removed.lost ? (
                <>
                  <span>La revue s'est terminée : la remarque effacée sur {removed.title} n'est pas remise. Son texte :</span>
                  <textarea className={styles.textarea} readOnly value={removed.text} aria-label="Texte de la remarque effacée" />
                </>
              ) : (
                <>
                  Remarque effacée ({removed.title})
                  <button type="button" className={styles.linkButton} onClick={onRestore}>
                    Annuler
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className={styles.recapList}>
          {remarks.length > 0 && <div className={styles.group}>Remarques</div>}
          {remarks.map(({ step, answer }) => (
            <div key={answer.id} className={styles.item}>
              <span className={cx(styles.dot, styles.dotRemark)} />
              <div className={styles.itemBody}>
                <span className={styles.itemTitle}>
                  {titleOf(step)}
                  {stepIsGroup(step) && ` · sur ${titleOfArtboard(step, answer.on ?? step)}`}
                  {step.removed && ` · ${step.removed === "deleted" ? "artboard supprimé" : "page archivée"}`}
                </span>
                <span className={styles.itemText}>{answer.text}</span>
                <span className={styles.itemBy}>
                  {nameOfAnswer(answer, "Toi")}
                  {alsoValidated(step)}
                </span>
              </div>
              {open && answer.mine && (
                <div className={styles.itemActions}>
                  {!step.removed && (
                    <button type="button" className={styles.panelButton} onClick={() => onGo(indexOf(step))}>
                      Modifier
                    </button>
                  )}
                  <button type="button" className={styles.panelButton} onClick={() => onRemove(answer.id, step.id, answer.text ?? "", titleOf(step))}>
                    Effacer
                  </button>
                </div>
              )}
            </div>
          ))}
          {okSteps.length > 0 && <div className={styles.group}>OK</div>}
          {okSteps.length > 0 && (
            <div className={styles.item}>
              <span className={cx(styles.dot, styles.dotOk)} />
              <div className={styles.itemBody}>
                <span className={styles.stepList}>{okSteps.map((step) => `${titleOf(step)} (${step.answers.filter((answer) => !answer.outdated).map((answer) => nameOfAnswer(answer, "toi")).join(", ")})`).join(", ")}</span>
              </div>
            </div>
          )}
          {notSeen.length > 0 && <div className={styles.group}>Non vus ({notSeen.length})</div>}
          {notSeen.length > 0 && (
            <div className={styles.item}>
              <span className={styles.dot} />
              <div className={styles.itemBody}>
                <span className={styles.stepList}>
                  {notSeen.map((step, position) => (
                    <span key={step.id}>
                      {position > 0 && ", "}
                      <button type="button" className={styles.stepLink} onClick={() => onGo(indexOf(step))}>
                        {titleOf(step)}
                      </button>
                      {step.answers.length > 0 && " (modifié depuis ton OK)"}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
