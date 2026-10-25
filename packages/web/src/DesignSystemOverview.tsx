import { useEffect, useState } from "react";
import type { DesignMdResponse, DesignSystemDetail, DiffusionListItem, RollbackImpact } from "@redline/shared";
import { useDesignSystemDetail, useOpenDiffusionDialog } from "./DiffusionDialog.js";
import { componentCountLabel, diffusionChangeParts, pageCountLabel, pendingCountLabel, pendingNames, tokenCountLabel, usagePlaceLabel, usedByHeading, userSummary } from "./diffusionLabels.js";
import { agree } from "./plural.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { NewPageDialog } from "./NewPageDialog.js";
import { routeHref } from "./router.js";
import { Button, Dialog, DialogActions, Logo, cx } from "./ui/index.js";
import styles from "./DesignSystemOverview.module.css";

const dayAndTime = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
};

function Names({ names, more }: { names: string[]; more: boolean }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && ", "}
          <span className={styles.mono}>{name}</span>
        </span>
      ))}
      {more && "…"}
    </>
  );
}

function PageCard({ page, palette }: { page: DesignSystemDetail["pages"][number]; palette: string[] }) {
  const pending = page.pendingCount > 0;
  const listed = page.componentNames.slice(0, 3).join(", ");
  return (
    <a href={routeHref({ name: "page", pageId: page.id })} data-testid="ds-page" className={cx(styles.pageCard, pending && styles.pageCardPending)}>
      <div aria-hidden="true" className={styles.pageThumb}>
        {palette.map((colour, index) => (
          <div key={index} className={styles.swatch} style={{ background: colour }} />
        ))}
        <div className={styles.aa}>Aa</div>
      </div>
      <div className={styles.pageText}>
        <div className={styles.pageTitleRow}>
          <span className={styles.pageTitle}>{page.title}</span>
          {pending && (
            <>
              <span className={styles.grow} />
              <span className={styles.pendingPill}>
                {page.pendingCount} {agree(page.pendingCount, "non diffusé", "non diffusés")}
              </span>
            </>
          )}
        </div>
        <span className={styles.pageMeta}>
          {componentCountLabel(page.componentCount)}
          {listed && ` · ${listed}${page.componentCount > 3 ? "…" : ""}`}
        </span>
      </div>
    </a>
  );
}

function RollbackDialog({ designSystemId, target, onClose, onRolledBack }: { designSystemId: string; target: number; onClose: () => void; onRolledBack: () => void }) {
  const [impact, setImpact] = useState<RollbackImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const label = `Revenir à la diffusion ${target}`;

  useEffect(() => {
    fetch(`/api/design-systems/${designSystemId}/diffusions/${target}/rollback-impact`)
      .then((res) => res.json() as Promise<RollbackImpact>)
      .then(setImpact);
  }, [designSystemId, target]);

  async function rollBack() {
    setBusy(true);
    await fetch(`/api/design-systems/${designSystemId}/diffusions/${target}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    onRolledBack();
  }

  return (
    <Dialog title={label} onClose={onClose} width={520}>
      <div className={styles.rollbackText}>Tous les projets reçoivent à nouveau la diffusion {target}. Les pages du design system gardent leur version actuelle, pour que tu puisses la corriger.</div>
      {impact && impact.components.length > 0 && (
        <div role="alert" data-testid="rollback-warning" className={styles.rollbackWarning}>
          <b>Des pages utilisent des composants ajoutés depuis :</b>
          <ul className={styles.rollbackList}>
            {impact.components.map((component) => (
              <li key={component.name}>
                <span className={styles.mono}>{component.name}</span> : {component.usedBy.map(usagePlaceLabel).join(", ")}
              </li>
            ))}
          </ul>
          Ces pages perdront le style de ces composants.
        </div>
      )}
      <DialogActions>
        <Button size="lg" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="accent" size="lg" disabled={busy || impact === null} onClick={() => void rollBack()}>
          {label}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DiffusionRow({ diffusion, isCurrent, isFirst, canRollBack, onRollBack }: { diffusion: DiffusionListItem; isCurrent: boolean; isFirst: boolean; canRollBack: boolean; onRollBack: () => void }) {
  const parts = diffusionChangeParts(diffusion.changes);
  return (
    <div data-testid="diffusion-row" className={cx(styles.diffusionRow, diffusion.undone && styles.diffusionUndone)}>
      <span className={styles.diffusionNumber}>Diffusion {diffusion.number}</span>
      {isCurrent && <span className={styles.currentPill}>en cours</span>}
      {diffusion.undone && <span className={styles.undonePill}>annulée</span>}
      <span className={styles.diffusionSummary}>
        {diffusion.rolledBackTo !== undefined
          ? `Retour à la diffusion ${diffusion.rolledBackTo}`
          : isFirst
          ? "Version initiale"
          : parts.length === 0
            ? "Aucun changement"
            : parts.map((part, index) => (
                <span key={part.label}>
                  {index > 0 && " · "}
                  {part.label}
                  {part.names.length > 0 && (
                    <>
                      {part.separator === ":" ? " : " : " · "}
                      <Names names={part.names} more={part.more} />
                    </>
                  )}
                </span>
              ))}
      </span>
      <span className={styles.diffusionDate}>{dayAndTime(diffusion.createdAt)}</span>
      {canRollBack ? (
        <button type="button" className={styles.rollBack} onClick={onRollBack}>
          Revenir à cette diffusion
        </button>
      ) : (
        <span className={styles.diffusionAction} />
      )}
    </div>
  );
}

export function DesignSystemOverview({ designSystemId }: { designSystemId: string }) {
  const [reloads, setReloads] = useState(0);
  const detail = useDesignSystemDetail(designSystemId, String(reloads));
  const openDiffusion = useOpenDiffusionDialog();
  const [diffusions, setDiffusions] = useState<DiffusionListItem[]>([]);
  const [designMd, setDesignMd] = useState("");
  const [creatingPage, setCreatingPage] = useState(false);
  const [rollbackTo, setRollbackTo] = useState<number | null>(null);
  const currentNumber = detail?.current.number;

  useEffect(() => {
    fetch(`/api/design-systems/${designSystemId}/diffusions`)
      .then((res) => res.json() as Promise<DiffusionListItem[]>)
      .then(setDiffusions);
  }, [designSystemId, currentNumber, reloads]);

  useEffect(() => {
    fetch(`/api/projects/${designSystemId}/design-md`)
      .then((res) => res.json() as Promise<DesignMdResponse>)
      .then((body) => setDesignMd(body.content));
  }, [designSystemId]);

  if (!detail) return <main className={styles.screen}>Chargement…</main>;

  const pendingCount = detail.pending.count;
  const listed = pendingNames(detail.pending);

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <a href={routeHref({ name: "home" })} aria-label="Accueil" className={styles.logoLink}>
          <Logo />
        </a>
        <nav aria-label="Fil d'Ariane" className={styles.breadcrumb}>
          <a href={routeHref({ name: "designSystems" })}>Design systems</a>
          <span aria-hidden="true">/</span>
          <span className={styles.current}>{detail.title}</span>
        </nav>
        <div className={styles.grow} />
        {pendingCount > 0 && (
          <button type="button" className={styles.diffuse} onClick={() => openDiffusion(detail.id)}>
            Diffuser aux projets <span className={styles.diffuseCount}>{pendingCount}</span>
          </button>
        )}
        <button type="button" className={styles.newPage} onClick={() => setCreatingPage(true)}>
          Nouvelle page
        </button>
      </header>

      <div className={styles.body}>
        <main className={styles.main}>
          <div className={styles.heading}>
            <h1 className={styles.title}>{detail.title}</h1>
            <div data-testid="ds-stats" className={styles.stats}>
              {`Design system · ${pageCountLabel(detail.pages.length)} · ${componentCountLabel(detail.componentCount)} · ${tokenCountLabel(detail.tokenCount)} · diffusion ${detail.current.number} en cours`}
            </div>
          </div>

          {pendingCount > 0 && (
            <div data-testid="pending-banner" className={styles.banner}>
              <span aria-hidden="true" className={styles.bannerDot} />
              <span>
                {pendingCountLabel(pendingCount)} : <Names names={listed.names} more={listed.more} />
              </span>
              <div className={styles.grow} />
              <button type="button" className={styles.bannerLink} onClick={() => openDiffusion(detail.id)}>
                Diffuser…
              </button>
            </div>
          )}

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Pages</h2>
            <div className={styles.pages}>
              {detail.pages.map((page) => (
                <PageCard key={page.id} page={page} palette={detail.palette} />
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Diffusions</h2>
            <div className={styles.diffusions}>
              {diffusions.map((diffusion, index) => (
                <DiffusionRow
                  key={diffusion.number}
                  diffusion={diffusion}
                  isCurrent={diffusion.number === detail.current.number}
                  isFirst={index === diffusions.length - 1}
                  canRollBack={diffusion.number < detail.current.number && !diffusion.undone}
                  onRollBack={() => setRollbackTo(diffusion.number)}
                />
              ))}
            </div>
            <div className={styles.diffusionNote}>
              Revenir à une diffusion la renvoie à tous les projets. Les pages du design system gardent leur version actuelle, pour que tu puisses la corriger.
            </div>
          </section>
        </main>

        <aside aria-label="Contexte du design system" className={styles.side}>
          <section className={styles.sideSection}>
            <h2 className={styles.sideTitle}>{usedByHeading(detail.usedBy.length)}</h2>
            <div className={styles.users}>
              {detail.usedBy.map((user) => (
                <a key={user.id} href={routeHref({ name: "projectDesignSystem", projectId: user.id })} data-testid="ds-user" className={styles.user}>
                  <span className={styles.userTitle}>{user.title}</span>
                  <span className={cx(styles.userSummary, user.overrideCount > 0 && styles.userOverridden)}>{userSummary(user)}</span>
                </a>
              ))}
            </div>
          </section>

          <section className={styles.sideSection}>
            <div className={styles.designMdHeading}>
              <h2 className={styles.designMdTitle}>DESIGN.md</h2>
              <div className={styles.grow} />
              <a href={routeHref({ name: "designMd", projectId: detail.id })}>Modifier</a>
            </div>
            <div className={styles.sideText}>
              Règles de la marque, lues par les sessions de tous les projets qui utilisent {detail.title}. Les règles d'un projet l'emportent en cas de conflit.
            </div>
            <div className={styles.markdown}>
              <MarkdownPreview source={designMd} />
            </div>
          </section>
        </aside>
      </div>

      {rollbackTo !== null && (
        <RollbackDialog
          designSystemId={detail.id}
          target={rollbackTo}
          onClose={() => setRollbackTo(null)}
          onRolledBack={() => {
            setRollbackTo(null);
            setReloads((n) => n + 1);
          }}
        />
      )}

      {creatingPage && (
        <NewPageDialog
          projectId={detail.id}
          projectTitle={detail.title}
          designSystem={null}
          onClose={() => setCreatingPage(false)}
          onCreated={(page) => {
            window.location.hash = routeHref({ name: "page", pageId: page.id });
          }}
        />
      )}
    </div>
  );
}
