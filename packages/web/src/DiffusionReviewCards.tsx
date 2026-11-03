import { useState, type ReactNode } from "react";
import { isColorValue, type DesignSystemDetail, type DiffusionReview, type ReviewChange, type ReviewComponent, type ReviewToken } from "@redline/shared";
import { routeHref } from "./router.js";
import { agree } from "./plural.js";
import { componentsHeading, keptByText, originText, tokensWhereText, whereSummary } from "./reviewLabels.js";
import { cx } from "./ui/index.js";
import styles from "./DiffusionReviewCards.module.css";

function Value({ value, muted }: { value: string; muted?: boolean }) {
  return (
    <span className={cx(styles.value, muted && styles.muted)}>
      {isColorValue(value) && <span aria-hidden="true" className={styles.swatch} style={{ background: value }} />}
      {value}
    </span>
  );
}

function TokenValues({ token }: { token: ReviewToken }) {
  if (token.kind === "changed") {
    return (
      <span className={styles.values}>
        <Value value={token.from!} />
        <span aria-hidden="true" className={styles.arrow}>→</span>
        <Value value={token.to!} />
      </span>
    );
  }
  return <Value value={token.kind === "added" ? token.to! : token.from!} muted={token.kind === "removed"} />;
}

/** One line of a card's "Ce qui change"; `action` is the slot of the "Refuser" button (ticket 14). */
function ChangeRow({ children, origin, action }: { children: ReactNode; origin: string; action?: ReactNode }) {
  return (
    <div className={styles.changeRow} data-testid="review-change">
      {children}
      <span className={styles.origin}>{origin}</span>
      <span className={styles.grow} />
      {action}
    </div>
  );
}

function ReviewCard({ title, mono, pill, action, children }: { title: string; mono?: boolean; pill?: ReactNode; /** The "Avant / après" or "Voir le composant" link (ticket 15). */ action?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={cx(styles.cardTitle, mono && styles.mono)}>{title}</span>
        {pill}
        <span className={styles.grow} />
        {action}
      </div>
      {children}
    </div>
  );
}

function ChangesList({ children }: { children: ReactNode }) {
  return (
    <div className={styles.block}>
      <span className={styles.blockTitle}>Ce qui change</span>
      <div className={styles.rows}>{children}</div>
    </div>
  );
}

function ChangeLine({ change, onRefused }: { change: ReviewChange; onRefused: () => void }) {
  const [busy, setBusy] = useState(false);
  const refuse = async () => {
    setBusy(true);
    await fetch(`/api/changes/${change.changeId}/refuse`, { method: "POST" });
    setBusy(false);
    onRefused();
  };
  return (
    <ChangeRow
      origin={originText(change.origin)}
      action={
        change.undoing ? (
          <span className={styles.undoing} data-testid="change-undoing">annulation en cours</span>
        ) : change.refusable && change.changeId ? (
          <button type="button" className={styles.small} disabled={busy} onClick={() => void refuse()}>
            Refuser
          </button>
        ) : undefined
      }
    >
      <span className={styles.label}>{change.label}</span>
    </ChangeRow>
  );
}

function WhereLine({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className={styles.whereLine}>
      <span className={styles.blockTitle}>{title}</span>
      <span>{children}</span>
      <span className={styles.grow} />
      {aside}
    </div>
  );
}

const KIND_PILL = { changed: ["modifié", styles.pillChanged], added: ["nouveau", styles.pillAdded], removed: ["supprimé", styles.pillRemoved] } as const;

function ComponentCard({ component, designSystemId, onRefused }: { component: ReviewComponent; designSystemId: string; onRefused: () => void }) {
  const [open, setOpen] = useState(false);
  const { where } = component;
  const [pillText, pillClass] = KIND_PILL[component.kind];
  return (
    <div data-testid="diffusion-component" data-component={component.name}>
      <ReviewCard title={`ui-${component.name}`} mono pill={<span className={cx(styles.pill, pillClass)}>{pillText}</span>}>
        <ChangesList>
          {component.changes.map((change) => <ChangeLine key={change.changeId ?? change.label} change={change} onRefused={onRefused} />)}
        </ChangesList>
        <div className={styles.block}>
          {where.pages.length > 0 ? (
            <>
              <WhereLine
                title="Où ça change"
                aside={
                  <button type="button" className={styles.small} aria-expanded={open} onClick={() => setOpen(!open)}>
                    {open ? "Masquer les pages" : "Voir les pages"}
                  </button>
                }
              >
                {whereSummary(where.instances, where.pages.length)}
              </WhereLine>
              {open && (
                <div className={styles.rows}>
                  {where.pages.map((page) => (
                    <div key={page.pageId} className={styles.pageRow} data-testid="review-page">
                      <span className={styles.pageProject}>{page.projectTitle}</span>
                      <span className={styles.label}>{page.pageTitle}</span>
                      <span className={styles.origin}>{page.instances} {agree(page.instances, "instance", "instances")}</span>
                      <span className={styles.grow} />
                      <a href={`${window.location.pathname}${routeHref({ name: "page", pageId: page.pageId, previewOf: designSystemId })}`} target="_blank" rel="noreferrer" className={styles.link}>
                        Aperçu ↗
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <WhereLine title="Où ça change">{where.keptBy.length > 0 ? keptByText(where.keptBy, component.name) : "Nulle part pour l'instant"}</WhereLine>
          )}
        </div>
      </ReviewCard>
    </div>
  );
}

/** The cards of the Diffuse dialog: tokens and DESIGN.md first, then one card per component whose definition differs. */
export function DiffusionReviewCards({ review, detail, onRefused }: { review: DiffusionReview; detail: DesignSystemDetail; /** A change was refused: the review has to be read again. */ onRefused: () => void }) {
  const hasTokenCards = review.tokens.length > 0 || review.designMdChanged;
  return (
    <section className={styles.section}>
      {hasTokenCards && <h3 className={styles.sectionTitle}>Tokens et DESIGN.md</h3>}
      {review.tokens.length > 0 && (
        <ReviewCard title="Tokens">
          <ChangesList>
            {review.tokens.map((token) => (
              <ChangeRow key={token.name} origin={originText({ kind: "direct" })}>
                <span className={cx(styles.label, styles.mono)}>{token.name}</span>
                <TokenValues token={token} />
                {token.kind !== "changed" && <span className={cx(styles.pill, token.kind === "added" ? styles.pillAdded : styles.pillRemoved)}>{token.kind === "added" ? "nouveau" : "supprimé"}</span>}
              </ChangeRow>
            ))}
          </ChangesList>
          <div className={styles.block}>
            <WhereLine title="Où ça change">{tokensWhereText(review.projects)}</WhereLine>
            {detail.overrides.map((project) => (
              <div key={project.id} className={styles.warning} data-testid="diffusion-override">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.warningIcon}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 16h.01" />
                </svg>
                <span>
                  <b>{project.title}</b> surcharge{" "}
                  {project.tokens.map((token, index) => (
                    <span key={token}>
                      {index > 0 && ", "}
                      <span className={styles.mono}>{token}</span>
                    </span>
                  ))}{" "}
                  : {agree(project.tokens.length, "ce changement y sera sans effet.", "ces changements y seront sans effet.")}
                </span>
              </div>
            ))}
          </div>
        </ReviewCard>
      )}
      {review.designMdChanged && (
        <ReviewCard title="DESIGN.md">
          <ChangesList>
            <ChangeRow origin={originText({ kind: "direct" })}>
              <span className={styles.label}>DESIGN.md modifié</span>
            </ChangeRow>
          </ChangesList>
          <div className={styles.block}>
            <WhereLine title="Où ça change">Les prochaines sessions des projets</WhereLine>
          </div>
        </ReviewCard>
      )}
      {review.components.length > 0 && <h3 className={cx(styles.sectionTitle, hasTokenCards && styles.afterCards)}>{componentsHeading(review.components.length)}</h3>}
      {review.components.map((component) => <ComponentCard key={component.name} component={component} designSystemId={detail.id} onRefused={onRefused} />)}
    </section>
  );
}
