import { useCallback, useEffect, useRef, useState } from "react";
import type { ComparisonSide, ComponentComparison } from "@redline/shared";
import { useDesignSystemDetail } from "./DiffusionDialog.js";
import { useDocumentTitle } from "./documentTitle.js";
import { originText } from "./reviewLabels.js";
import { routeHref } from "./router.js";
import { Logo, cx } from "./ui/index.js";
import styles from "./BeforeAfterScreen.module.css";

const UNDO_POLL_MS = 3_000;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const PANEL_PADDING = 24;

const percent = (zoom: number) => `${Math.round(zoom * 100)} %`;
const zoomedOut = (zoom: number) => [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? ZOOM_STEPS[0]!;
const zoomedIn = (zoom: number) => ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

function ZoomControls({ zoom, onChange, onFit }: { zoom: number; onChange: (zoom: number) => void; onFit: () => void }) {
  return (
    <div role="group" aria-label="Zoom" className={styles.zoom}>
      <button type="button" aria-label="Dézoomer" className={styles.zoomButton} onClick={() => onChange(zoomedOut(zoom))}>
        −
      </button>
      <span data-testid="zoom-percent" className={styles.percent}>
        {percent(zoom)}
      </span>
      <button type="button" aria-label="Zoomer" className={styles.zoomButton} onClick={() => onChange(zoomedIn(zoom))}>
        +
      </button>
      <span aria-hidden="true" className={styles.zoomSeparator} />
      <button type="button" className={styles.zoomButton} onClick={onFit}>
        Ajuster
      </button>
    </div>
  );
}

interface PanelProps {
  label: string;
  hint: string;
  side: ComparisonSide;
  artboardOrigin: string;
  markersVisible: boolean;
  /** Changes when the artboard has to be loaded again (a refused change was undone). */
  reloadKey: string;
}

/** One side: its own zoom, its own scroll, the artboard in an iframe scaled at the chosen zoom. */
function Panel({ label, hint, side, artboardOrigin, markersVisible, reloadKey }: PanelProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);
  const [documentHeight, setDocumentHeight] = useState(side.height);

  useEffect(() => {
    const element = body.current!;
    const observer = new ResizeObserver(([entry]) => setAvailable({ width: entry!.contentRect.width, height: entry!.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const height = Math.max(documentHeight, 1);
  const fit = available === null ? 1 : Math.min(1, (available.width - 2 * PANEL_PADDING) / side.width, (available.height - 2 * PANEL_PADDING) / height);
  const zoom = chosen ?? fit;

  const sendMarkers = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: "redline:set-compare-markers", visible: markersVisible, markers: side.markers }, "*");
  }, [markersVisible, side.markers]);

  useEffect(sendMarkers, [sendMarkers]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data) return;
      if (event.data.type === "redline:ready") sendMarkers();
      if (event.data.type === "redline:doc-height") setDocumentHeight(Math.max(event.data.height as number, 1));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendMarkers]);

  return (
    <section aria-label={label} className={styles.side}>
      <div className={styles.sideHead}>
        <h2 className={styles.sideTitle}>{label}</h2>
        <span className={styles.sideHint}>{hint}</span>
        <span className={styles.grow} />
        <ZoomControls zoom={zoom} onChange={setChosen} onFit={() => setChosen(null)} />
      </div>
      <div ref={body} className={styles.canvas}>
        <div className={styles.scaled} style={{ width: side.width * zoom, height: height * zoom }}>
          {artboardOrigin && (
            <iframe
              key={reloadKey}
              ref={frame}
              title={label}
              src={`${artboardOrigin}${side.url}`}
              sandbox="allow-scripts"
              className={styles.frame}
              style={{ width: side.width, height, transform: `scale(${zoom})` }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function ChangeList({ comparison, onRefused }: { comparison: ComponentComparison; onRefused: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const refuse = async (changeId: string) => {
    setBusy(changeId);
    await fetch(`/api/changes/${changeId}/refuse`, { method: "POST" });
    setBusy(null);
    onRefused();
  };
  return (
    <div className={styles.changes}>
      {comparison.changes.map((change, index) => (
        <div key={change.changeId ?? change.label} className={styles.change} data-testid="before-after-change">
          <span aria-hidden="true" className={styles.number}>
            {index + 1}
          </span>
          <span className={styles.label}>{change.label}</span>
          <span className={styles.origin}>{originText(change.origin)}</span>
          <span className={styles.grow} />
          {change.undoing ? (
            <span className={styles.undoing} data-testid="change-undoing">
              annulation en cours
            </span>
          ) : change.refusable && change.changeId ? (
            <button type="button" className={styles.small} disabled={busy === change.changeId} onClick={() => void refuse(change.changeId!)}>
              Refuser
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function BeforeAfterScreen({ designSystemId, component }: { designSystemId: string; component: string }) {
  const detail = useDesignSystemDetail(designSystemId);
  const [comparison, setComparison] = useState<ComponentComparison | null | undefined>(undefined);
  const [artboardOrigin, setArtboardOrigin] = useState("");
  const [markersVisible, setMarkersVisible] = useState(true);
  const tag = `ui-${component}`;

  const load = useCallback(async () => {
    const res = await fetch(`/api/design-systems/${designSystemId}/components/${encodeURIComponent(component)}/comparison`);
    setComparison(res.ok ? ((await res.json()) as ComponentComparison) : null);
  }, [designSystemId, component]);

  useEffect(() => {
    void load();
    void fetch("/api/config")
      .then((res) => res.json() as Promise<{ artboardOrigin: string }>)
      .then((config) => setArtboardOrigin(config.artboardOrigin));
  }, [load]);

  // A refused change stays "annulation en cours" until the design system's session undoes it in the draft: read it again meanwhile.
  const undoing = comparison?.changes.some((change) => change.undoing) ?? false;
  useEffect(() => {
    if (!undoing) return;
    const timer = setInterval(() => void load(), UNDO_POLL_MS);
    return () => clearInterval(timer);
  }, [undoing, load]);

  const added = comparison?.kind === "added";
  const title = `${added ? "Voir le composant" : "Avant / après"} · ${tag}`;
  useDocumentTitle(title, detail?.title);
  const reloadKey = comparison ? comparison.changes.map((change) => `${change.changeId ?? change.label}:${change.undoing}`).join("|") : "";

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <a href={routeHref({ name: "home" })} aria-label="Accueil" className={styles.logoLink}>
          <Logo />
        </a>
        <nav aria-label="Fil d'Ariane" className={styles.breadcrumb}>
          <a href={routeHref({ name: "designSystems" })}>Design systems</a>
          <span aria-hidden="true">/</span>
          <a href={routeHref({ name: "designSystem", designSystemId })}>{detail?.title ?? ""}</a>
          <span aria-hidden="true">/</span>
          <span className={styles.current}>
            {added ? "Voir le composant" : "Avant / après"} · <span className={styles.mono}>{tag}</span>
          </span>
        </nav>
        <div className={styles.grow} />
        <a href={routeHref({ name: "designSystem", designSystemId, review: true })} className={styles.back}>
          Retour à la relecture
        </a>
      </header>
      <main className={styles.main}>
        {comparison === null && <div className={styles.empty}>{tag} n’a aucun changement en attente.</div>}
        {comparison && (
          <>
            <section className={styles.changesSection}>
              <div className={styles.changesHead}>
                <h2 className={styles.changesTitle}>Ce qui change dans {tag}</h2>
                <span className={styles.changesHint}>ajouté : repère à droite · retiré : à gauche · modifié : des deux côtés</span>
                <span className={styles.grow} />
                <button type="button" aria-pressed={markersVisible} className={cx(styles.markers, markersVisible && styles.markersOn)} onClick={() => setMarkersVisible(!markersVisible)}>
                  <span aria-hidden="true" className={styles.markersDot} />
                  Repères
                </button>
              </div>
              <ChangeList comparison={comparison} onRefused={() => void load()} />
            </section>
            <div className={styles.sides}>
              {comparison.diffused && (
                <Panel label="Diffusé" hint={`version ${comparison.diffusion} · ce que les projets affichent aujourd’hui`} side={comparison.diffused} artboardOrigin={artboardOrigin} markersVisible={markersVisible} reloadKey={reloadKey} />
              )}
              {comparison.draft && (
                <Panel label="Brouillon" hint="ce qu’ils afficheront après la diffusion" side={comparison.draft} artboardOrigin={artboardOrigin} markersVisible={markersVisible} reloadKey={reloadKey} />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
