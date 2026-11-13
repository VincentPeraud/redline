import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RESPONSIVE_FORMATS, progressOf, renderingKey, renderingLabel, stepIsModified, stepIsSeen, stepStatus, type ArtboardRendering, type ChangeReview, type ChangeReviewStep, type TweakValues } from "@redline/shared";
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
import { LeaveDialog, PersonDot, RemarkEditor, personName } from "./ReviewRemark.js";
import styles from "./ReviewScreen.module.css";

type Load = { status: "loading" } | { status: "missing" } | { status: "refused" } | { status: "error" } | { status: "ready"; review: ChangeReview };

type View = number | "recap";

const reviewPath = (reviewId: string) => `/api/change-reviews/${encodeURIComponent(reviewId)}`;

/** First step without an answer after `from`, else any earlier one, else the recap. */
function nextUnanswered(review: ChangeReview, from: number): View {
  const after = review.steps.findIndex((step, index) => index > from && !stepIsSeen(step));
  const anywhere = after !== -1 ? after : review.steps.findIndex((step) => !stepIsSeen(step));
  return anywhere === -1 ? "recap" : anywhere;
}

const stepRoute = (reviewId: string, view: View): Route => ({ name: "review", reviewId, step: view === "recap" ? "recap" : view + 1 });

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

/** The review mode: a variant of Present limited to the steps Claude declared, with its own red identity. */
export function ReviewScreen({ reviewId, step }: { reviewId: string; step?: number | "recap" }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [failed, setFailed] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | undefined>();
  const controlsOf = useReviewControls();

  // A remark Redline has not received: closing the tab asks first, and so does leaving the step.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const reload = useCallback(async () => {
    try {
      const response = await fetch(reviewPath(reviewId));
      if (response.status === 404) return setLoad({ status: "missing" });
      if (response.status === 403) return setLoad({ status: "refused" });
      if (!response.ok) return setLoad({ status: "error" });
      setLoad({ status: "ready", review: (await response.json()) as ChangeReview });
    } catch {
      setLoad({ status: "error" });
    }
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

  // The address names the step as soon as the review shows, so answering never moves the member to another one.
  useEffect(() => {
    if (review && step === undefined) navigateTo(stepRoute(reviewId, review.state !== "open" ? "recap" : nextUnanswered(review, -1)), "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.id, step]);
  useDocumentTitle(review ? `Revue · ${review.projectTitle}` : "Revue");

  /** Sends one change of the member's answer; the answer is the review as it stands then. */
  async function change(method: "PUT" | "DELETE" | "POST", path: string): Promise<ChangeReview | undefined> {
    setFailed(false);
    const response = await fetch(`${reviewPath(reviewId)}${path}`, { method }).catch(() => undefined);
    if (!response?.ok) {
      setFailed(true);
      // A 409 means the review was finished meanwhile: show it as it is.
      if (response?.status === 409) void reload();
      return undefined;
    }
    const next = (await response.json()) as ChangeReview;
    setLoad({ status: "ready", review: next });
    return next;
  }

  if (load.status !== "ready") return <StateScreen status={load.status} onRetry={() => void reload()} />;
  const view: View = step === undefined ? (review!.state !== "open" ? "recap" : nextUnanswered(review!, -1)) : step === "recap" || step > review!.steps.length ? "recap" : step - 1;
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
  const finish = () => void change("POST", "/finish").then((next) => next && navigate("recap"));

  return (
    <div data-testid="review" className={styles.review}>
      <TopBar review={review!} view={view} controls={view === "recap" ? undefined : controlsOf(review!.steps[view]!)} onGo={go} onLeave={guard} onFinish={() => guard(finish)} />
      {view === "recap" ? (
        <Recap review={review!} failed={failed} onGo={go} onFinish={() => guard(finish)} />
      ) : (
        <StepView
          key={review!.steps[view]!.id}
          review={review!}
          index={view}
          controls={controlsOf(review!.steps[view]!)}
          failed={failed}
          onGo={go}
          onOk={() => guard(() => void answerOk(view))}
          onClearAndValidate={() => guard(() => void clearRemarkAndValidate(view))}
          onCancel={() => cancelOk(view)}
          remark={{ reviewPath: reviewPath(reviewId), onReview: (next) => setLoad({ status: "ready", review: next }), onReload: () => void reload(), onUnsaved: setUnsaved }}
        />
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

function StateScreen({ status, onRetry }: { status: Exclude<Load["status"], "ready">; onRetry: () => void }) {
  const text = {
    loading: { title: "Chargement de la revue", detail: "" },
    missing: { title: "Revue introuvable", detail: "Le lien est incomplet, ou le projet a été supprimé." },
    refused: {
      title: "Revue réservée aux membres de l'équipe en Écriture",
      detail: "Ton accès à cette page (membre en Lecture ou Commentaire, ou lien de partage) ne permet pas de participer à la revue. Tu peux toujours commenter les artboards depuis le canvas si ton accès le permet.",
    },
    error: { title: "La revue n'a pas pu se charger", detail: "Tes réponses déjà enregistrées sont gardées." },
  }[status];
  return (
    <div data-testid="review" className={styles.review}>
      <header data-testid="review-top" className={styles.top}>
        <div className={styles.lead}>
          <button type="button" className={styles.button} onClick={() => navigateTo({ name: "home" })}>
            ← Canvas
          </button>
          <span className={styles.mode}>Revue</span>
        </div>
      </header>
      <div className={styles.stateScreen} role={status === "loading" ? "status" : undefined}>
        <h1>{text.title}</h1>
        {text.detail && <p>{text.detail}</p>}
        {status === "error" && (
          <button type="button" className={cx(styles.panelButton, styles.accent)} style={{ flex: "0 0 auto" }} onClick={onRetry}>
            Réessayer
          </button>
        )}
        {status === "refused" && (
          <button type="button" className={styles.panelButton} style={{ flex: "0 0 auto" }} onClick={() => navigateTo({ name: "home" })}>
            Retour au canvas
          </button>
        )}
      </div>
    </div>
  );
}

/** "Desktop", or "Desktop · 1440" when the artboard has several renderings of the same format. */
const renderingOptionLabel = (renderings: ArtboardRendering[], rendering: ArtboardRendering) =>
  renderings.filter((other) => other.format === rendering.format).length > 1 ? renderingLabel(rendering) : RESPONSIVE_FORMATS[rendering.format].label;

function TopBar({ review, view, controls, onGo, onLeave, onFinish }: { review: ChangeReview; view: View; controls?: StepControls; onGo: (view: View) => void; onLeave: (action: () => void) => void; onFinish: () => void }) {
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

  const total = review.steps.length;
  const position = view === "recap" ? total : view;
  const requester = review.requester.person;
  const place = review.requester.label ?? review.requester.folder.split(/[\\/]/).filter(Boolean).pop() ?? review.requester.folder;
  const backTo: Route = view === "recap" ? { name: "project", projectId: review.projectId } : { name: "page", pageId: review.steps[view]!.pageId };
  const groups = review.steps.reduce<{ pageId: string; title: string; entries: { step: ChangeReviewStep; index: number }[] }[]>((acc, entryStep, index) => {
    const last = acc[acc.length - 1];
    if (last && last.pageId === entryStep.pageId) last.entries.push({ step: entryStep, index });
    else acc.push({ pageId: entryStep.pageId, title: entryStep.pageTitle, entries: [{ step: entryStep, index }] });
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
        <button type="button" className={styles.button} aria-label="Étape précédente" disabled={view === "recap" ? total === 0 : view === 0} onClick={() => onGo(view === "recap" ? total - 1 : view - 1)}>
          ←
        </button>
        <button type="button" className={styles.counter} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          {view === "recap" ? "Avant de terminer" : `Étape ${position + 1} / ${total}`}
          <span className={styles.chev} aria-hidden="true">
            ▼
          </span>
        </button>
        <button type="button" className={styles.button} aria-label="Étape suivante" disabled={view === "recap"} onClick={() => onGo(view !== "recap" && view + 1 < total ? view + 1 : "recap")}>
          →
        </button>
        {menuOpen && (
          <div role="menu" aria-label="Étapes de la revue" className={styles.menu}>
            {groups.map((group) => (
              <div key={group.pageId}>
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
                    <span className={styles.menuNumber}>{index + 1}</span>
                    <span className={cx(styles.dot, stepDotClass(step), index === view && styles.dotCurrent)} />
                    <span className={styles.menuTitle}>
                      {step.pageTitle} · {step.artboardTitle}
                    </span>
                    <span className={styles.menuState}>{index === view ? "En cours" : stepIsModified(step) ? "Modifié" : STATUS_LABEL[stepStatus(step.answers)]}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.trail}>
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
        {review.state === "open" && (
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
          <i key={review.steps[position]!.id} className={cx(styles.segment, segment === "ok" && styles.segmentOk, segment === "remark" && styles.segmentRemark, segment === "current" && styles.segmentCurrent, segment === "modified" && styles.segmentChanged)} />
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
  failed,
  onGo,
  onOk,
  onClearAndValidate,
  onCancel,
  remark,
}: {
  review: ChangeReview;
  index: number;
  controls: StepControls;
  failed: boolean;
  onGo: (view: View) => void;
  onOk: () => void;
  onClearAndValidate: () => void;
  onCancel: () => void;
  remark: RemarkProps;
}) {
  const step = review.steps[index]!;
  const own = step.answers.find((answer) => answer.mine);
  const others = step.answers.filter((answer) => !answer.mine);
  const status = stepStatus(step.answers);
  const finished = review.state !== "open";
  // The member's own answer saw an older version of the artboard.
  const modified = stepIsModified(step) || own?.outdated === true;
  return (
    <div className={styles.body}>
      <ReviewStage review={review} step={step} modified={modified} controls={controls} />
      <aside aria-label="Question de l'étape" className={styles.panel}>
        <div className={styles.panelScroll}>
          <Progress review={review} index={index} />
          <div>
            <div className={styles.kicker}>
              <span>
                Page {step.pageTitle} · étape {index + 1} / {review.steps.length}
              </span>
              <span className={cx(styles.chip, !modified && status === "ok" && styles.chipOk, !modified && status === "remark" && styles.chipRemark, modified && styles.chipChanged)}>
                {modified ? "Modifié depuis ta revue" : status === "ok" ? "✓ OK" : STATUS_LABEL[status]}
              </span>
            </div>
            <h2 className={styles.heading}>
              {step.pageTitle} · {step.artboardTitle}
            </h2>
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
                    Revoir et valider
                  </button>
                ) : own?.kind === "remark" ? (
                  <span className={styles.hint}>Ta remarque remplace ton OK pour cette étape.</span>
                ) : own ? (
                  <button type="button" className={styles.panelButton} onClick={onCancel}>
                    ✓ Validé par toi · annuler
                  </button>
                ) : (
                  <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onOk}>
                    OK, étape suivante
                  </button>
                )}
              </div>
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
                <strong>Revue terminée</strong> par {personName(review.finishedBy)}
                {review.finishedAt ? ` le ${formatWhen(review.finishedAt)}` : ""} : plus de OK ni de remarque.
              </span>
            </div>
          )}
          <RemarkEditor stepId={step.id} own={own} finished={finished} {...remark} />
        </div>
        <div className={styles.panelFoot}>
          <button type="button" className={styles.panelButton} disabled={index === 0} onClick={() => onGo(index - 1)}>
            ← Précédente
          </button>
          <button type="button" className={styles.panelButton} onClick={() => onGo(index + 1 < review.steps.length ? index + 1 : "recap")}>
            Suivante →
          </button>
        </div>
      </aside>
    </div>
  );
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
function ReviewStage({ review, step, modified, controls }: { review: ChangeReview; step: ChangeReviewStep; modified: boolean; controls: StepControls }) {
  const origin = useArtboardOrigin(review.projectId);
  const stage = useRef<HTMLElement>(null);
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
    <main ref={stage} className={cx(styles.stage, controls.tweaksOpen && controls.tweaks.length > 0 && styles.stageTweaks)}>
      {modified && (
        <span data-testid="review-modified-tag" className={styles.tag}>
          Nouvelle version{step.modifiedBy ? ` de ${step.modifiedBy}` : ""} depuis ta revue{step.modifiedAt ? ` · ${relativeTime(step.modifiedAt)}` : ""}
        </span>
      )}
      {entry && presentation && fitted && origin ? (
        <PlayFrame frame={presentation.frame} url={entry.url}>
          <div className={styles.viewport} style={{ width: fitted.viewport.width * fitted.scale, height: fitted.viewport.height * fitted.scale }}>
            <ArtboardIframe
              ref={frame}
              title={`Revue / ${step.artboard}`}
              src={`${origin}/pages/${step.pageId}/${step.artboard}`}
              sandbox="allow-scripts"
              className={styles.frame}
              style={{ width: fitted.viewport.width, height: fitted.viewport.height, transform: `scale(${fitted.scale})` }}
            />
          </div>
        </PlayFrame>
      ) : entry ? null : (
        <p className={styles.hint}>Cet artboard n'existe plus · {step.artboard}</p>
      )}
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

function Recap({ review, failed, onGo, onFinish }: { review: ChangeReview; failed: boolean; onGo: (view: View) => void; onFinish: () => void }) {
  const seen = review.steps.filter((step) => stepStatus(step.answers) === "ok");
  const remarks = review.steps.filter((step) => stepStatus(step.answers) === "remark");
  const notSeen = review.steps.filter((step) => !stepIsSeen(step));
  const indexOf = (step: ChangeReviewStep) => review.steps.indexOf(step);
  if (review.state !== "open") {
    return (
      <div className={styles.screen}>
        <h1>Revue terminée</h1>
        <p>
          Terminée par {personName(review.finishedBy)}
          {review.finishedAt ? ` le ${formatWhen(review.finishedAt)}` : ""}. Plus de OK possible.
        </p>
        <p>Rien n'est envoyé à Claude : dis à ta conversation « j'ai fait mes retours » pour qu'elle récupère le résultat.</p>
        <Summary seen={seen} remarks={remarks} notSeen={notSeen} indexOf={indexOf} onGo={onGo} />
      </div>
    );
  }
  return (
    <div className={styles.screen}>
      <h1>Avant de terminer</h1>
      <div className={styles.counts}>
        <span className={cx(styles.chip, styles.chipOk)}>{seen.length} OK</span>
        <span className={cx(styles.chip, styles.chipRemark)}>{remarks.length} {remarks.length > 1 ? "remarques" : "remarque"}</span>
        <span className={styles.chip}>{notSeen.length} non vus</span>
      </div>
      <Summary seen={seen} remarks={remarks} notSeen={notSeen} indexOf={indexOf} onGo={onGo} />
      <div className={styles.actions}>
        <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onFinish}>
          Terminer la revue
        </button>
        {failed && <span className={cx(styles.hint, styles.error)}>Pas enregistré : Redline ne répond pas.</span>}
      </div>
    </div>
  );
}

function Summary({ seen, remarks, notSeen, indexOf, onGo }: { seen: ChangeReviewStep[]; remarks: ChangeReviewStep[]; notSeen: ChangeReviewStep[]; indexOf: (step: ChangeReviewStep) => number; onGo: (view: View) => void }) {
  const row = (step: ChangeReviewStep, by: string) => (
    <button key={step.id} type="button" className={styles.listItem} onClick={() => onGo(indexOf(step))}>
      <span className={styles.menuNumber}>{indexOf(step) + 1}</span>
      <span className={styles.listTitle}>
        {step.pageTitle} · {step.artboardTitle}
      </span>
      <span className={styles.listBy}>{by}</span>
    </button>
  );
  return (
    <div className={styles.columns}>
      <section className={styles.section}>
        <h3>OK ({seen.length})</h3>
        <div className={styles.list}>{seen.map((step) => row(step, step.answers.map((answer) => (answer.mine ? "Toi" : personName(answer.person))).join(", ")))}</div>
      </section>
      <section className={styles.section}>
        <h3>Remarques ({remarks.length})</h3>
        <div className={styles.list}>{remarks.map((step) => row(step, step.answers.filter((answer) => answer.kind === "remark").map((answer) => (answer.mine ? "Toi" : personName(answer.person))).join(", ")))}</div>
      </section>
      <section className={styles.section}>
        <h3>Non vus ({notSeen.length})</h3>
        <div className={styles.list}>{notSeen.map((step) => row(step, step.answers.length > 0 ? "Modifié depuis ton OK" : ""))}</div>
      </section>
    </div>
  );
}
