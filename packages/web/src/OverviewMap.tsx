import { useRef, type PointerEvent } from "react";
import type { ManifestElement } from "@redline/shared";
import { CanvasPhoto, type PhotoArtboard } from "./CanvasPhoto.js";
import { photoPointToCanvas, viewCentredOn, visibleArea, type PhotoFit } from "./canvasPhotoFit.js";
import type { Bounds, CanvasView } from "./canvasView.js";
import styles from "./OverviewMap.module.css";

const MAP_WIDTH = 200;
const MAP_PADDING = 12;
const MIN_MAP_HEIGHT = 80;
const MAX_MAP_HEIGHT = 300;

/** Height of the map for a canvas: the whole canvas at the map's width, between a floor and a ceiling. */
function mapHeight(bounds: Bounds): number {
  const scale = Math.min(1, (MAP_WIDTH - 2 * MAP_PADDING) / bounds.width);
  return Math.round(Math.min(MAX_MAP_HEIGHT, Math.max(MIN_MAP_HEIGHT, bounds.height * scale + 2 * MAP_PADDING)));
}

/**
 * "Vue d'ensemble (M)": the whole canvas in small, bottom right of the stage, with the part the viewport shows outlined in red.
 * A click or a drag on it brings that place to the centre of the viewport, at the same zoom. Hidden, it leaves a button to show it.
 */
export function OverviewMap({
  pageId,
  artboardOrigin,
  artboards,
  elements,
  view,
  viewport,
  visible,
  onToggle,
  onMove,
}: {
  pageId: string;
  artboardOrigin: string;
  artboards: PhotoArtboard[];
  elements: ManifestElement[];
  view: CanvasView;
  viewport: { width: number; height: number };
  visible: boolean;
  onToggle: () => void;
  onMove: (view: CanvasView) => void;
}) {
  const dragging = useRef(false);

  if (!visible) {
    return (
      <button type="button" data-testid="overview-show" title="Afficher la vue d'ensemble (M)" className={styles.showButton} onClick={onToggle}>
        Vue d'ensemble (M)
      </button>
    );
  }

  const visibleBox = visibleArea(view, viewport);
  const moveTo = (event: PointerEvent<HTMLDivElement>, fit: PhotoFit) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onMove(viewCentredOn(photoPointToCanvas({ x: event.clientX - rect.left, y: event.clientY - rect.top }, fit), view.zoom, viewport));
  };

  return (
    <section data-testid="overview-map" aria-label="Vue d'ensemble" className={styles.map}>
      <div className={styles.header}>
        <span className={styles.title}>Vue d'ensemble (M)</span>
        <button type="button" aria-label="Masquer la vue d'ensemble" title="Masquer la vue d'ensemble (M)" className={styles.hide} onClick={onToggle}>
          ×
        </button>
      </div>
      <CanvasPhoto
        pageId={pageId}
        artboardOrigin={artboardOrigin}
        artboards={artboards}
        elements={elements}
        height={mapHeight}
        padding={MAP_PADDING}
        className={styles.photo}
        overlay={(fit) => (
          <div
            className={styles.surface}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = true;
              moveTo(event, fit);
            }}
            onPointerMove={(event) => {
              if (dragging.current) moveTo(event, fit);
            }}
            onPointerUp={() => {
              dragging.current = false;
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
          >
            <div
              data-testid="overview-viewport"
              className={styles.viewport}
              style={{
                left: visibleBox.x * fit.scale + fit.x,
                top: visibleBox.y * fit.scale + fit.y,
                width: visibleBox.width * fit.scale,
                height: visibleBox.height * fit.scale,
              }}
            />
          </div>
        )}
      />
    </section>
  );
}
