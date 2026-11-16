import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { activeSteps, stepIsSeen, type ArtboardRef, type ChangeReview, type ChangeReviewPresence, type ChangeReviewStep } from "@redline/shared";
import { navigateTo } from "./router.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { useReviewControls } from "./useReviewControls.js";
import { useDocumentTitle } from "./documentTitle.js";
import { counted } from "./plural.js";
import { ConfirmDialog, LeaveDialog, personName } from "./ReviewRemark.js";
import { type Load, type RemovedRemark, type View, nextUnanswered, reviewPath, shownStep, stepRoute } from "./reviewView.js";
import { RemovedStep, StateScreen } from "./ReviewStates.js";
import { ReviewTopBar } from "./ReviewTopBar.js";
import { StepView } from "./ReviewStep.js";
import { ReviewRecap } from "./ReviewRecap.js";
import styles from "./ReviewScreen.module.css";

const PRESENCE_BEAT_MS = 20_000;
const UNDO_REMOVAL_MS = 5_000;

/** The review mode: a variant of Present limited to the steps Claude declared, with its own red identity. */
export function ReviewScreen({ reviewId, step }: { reviewId: string; step?: number | "recap" }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /** The last review shown, so a failed reload still names it in the header. */
  const lastReview = useRef<ChangeReview>();
  const [failed, setFailed] = useState(false);
  const [remarkUnsaved, setUnsaved] = useState(false);
  const [pinUnsaved, setPinUnsaved] = useState(false);
  const unsaved = remarkUnsaved || pinUnsaved;
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

  /** Loads the review as it stands now and answers it (undefined when it cannot be shown). A server that does not answer leaves a review already on screen alone: its unsaved text stays. */
  const reload = useCallback(async (): Promise<ChangeReview | undefined> => {
    const unreachable = () => setLoad((current) => (current.status === "ready" ? current : { status: "error" }));
    try {
      const response = await fetch(reviewPath(reviewId));
      if (response.status === 404) setLoad({ status: "missing" });
      else if (response.status === 403) setLoad({ status: "refused" });
      else if (!response.ok) unreachable();
      else {
        const next = (await response.json()) as ChangeReview;
        setLoad({ status: "ready", review: next });
        return next;
      }
    } catch {
      unreachable();
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
  const hasRemarks = review!.steps.some((entry) => entry.pins.length > 0 || entry.answers.some((answer) => answer.kind === "remark"));
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
  /** "Effacer mes retours et valider": the member's pins and remark go and an OK is recorded, in one call. */
  const clearFeedbackAndValidate = async (index: number) => {
    const next = await change("POST", `/steps/${review!.steps[index]!.id}/clear-and-validate`);
    if (next) navigate(nextUnanswered(next, index));
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
  const removeRemark = (answerId: string, stepId: string, text: string, title: string, on?: ArtboardRef) => {
    clearTimeout(removedTimer.current);
    void change("DELETE", `/remarks/${answerId}`).then((next) => {
      if (!next) return;
      setRemoved({ stepId, text, title, ...(on ? { on } : {}) });
      removedTimer.current = setTimeout(() => setRemoved(undefined), UNDO_REMOVAL_MS);
    });
  };
  const removePin = (pinId: string) => void change("DELETE", `/pins/${pinId}`);
  const restoreRemark = async () => {
    if (!removed) return;
    clearTimeout(removedTimer.current);
    const next = await change("PUT", `/steps/${removed.stepId}/remark`, { text: removed.text, ...(removed.on ? { pageId: removed.on.pageId, artboard: removed.on.artboard } : {}) });
    // The review was locked meanwhile: the text stays here, read-only.
    setRemoved(next ? undefined : { ...removed, lost: true });
  };

  return (
    <div data-testid="review" className={styles.review}>
      <ReviewTopBar review={review!} view={view} shown={view === "recap" || review!.steps[view]!.removed ? undefined : shownOf(review!.steps[view]!)} controls={view === "recap" || review!.steps[view]!.removed ? undefined : controlsOf(shownOf(review!.steps[view]!))} onGo={go} onLeave={guard} onFinish={requestFinish} />
      {view === "recap" ? (
        <ReviewRecap review={review!} failed={failed} removed={removed} onGo={go} onFinish={requestFinish} onReopen={reopen} onFile={() => setFiling(true)} onRemove={removeRemark} onRemovePin={removePin} onRestore={() => void restoreRemark()} />
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
          onClearAndValidate={() => guard(() => void clearFeedbackAndValidate(view))}
          onCancel={() => cancelOk(view)}
          onReopen={reopen}
          remark={{ reviewPath: reviewPath(reviewId), onReview: (next) => setLoad({ status: "ready", review: next }), onReload: () => void reload(), onUnsaved: setUnsaved, onPinUnsaved: setPinUnsaved }}
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
              ? "Elles seront signalées à part à la conversation comme « non vues », jamais comme validées. Plus personne ne pourra ajouter de retour, sauf si un membre rouvre la revue."
              : "Plus personne ne pourra ajouter de retour, sauf si un membre rouvre la revue."}
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
            setPinUnsaved(false);
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
  if (remarks.length === 0) return `Cette revue n'a aucun retour, mais elle ne sera jamais transmise à une conversation. ${final}`;
  if (remarks.length === 1) return `${remarks[0]!.mine ? "Ton retour" : `Le retour de ${personName(remarks[0]!.person)}`} ne sera jamais transmis à une conversation. ${final}`;
  const others = remarks.filter((answer) => !answer.mine);
  const names = [...new Set(others.map((answer) => personName(answer.person)))];
  const whose = others.length === 0 ? "" : ` (dont ${others.length === 1 ? "celui" : "ceux"} de ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`})`;
  return `Les ${remarks.length} retours${whose} ne seront jamais transmis à une conversation. ${final}`;
}
