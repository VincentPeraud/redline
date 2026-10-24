import { renderingKey, renderingLabel, type ArtboardRendering, type TweakValues } from "@redline/shared";
import { ArtboardFrame } from "./ArtboardFrame.js";
import type { ResponsiveFrameLayout } from "./canvasGeometry.js";
import styles from "./ResponsiveFrame.module.css";

interface Props {
  title: string;
  src: string;
  renderings: readonly ArtboardRendering[];
  layout: ResponsiveFrameLayout;
  zoom: number;
  tweaks: TweakValues;
  onDocHeight: (key: string, height: number) => void;
}

const formatPx = (value: number) => new Intl.NumberFormat("fr-FR").format(value).replace(/ /g, " ");

/**
 * The frame of a responsive artboard: every rendering of the same file side by side, each at the real
 * height of its page. Labels keep their screen size whatever the zoom; they sit in the frame's padding.
 */
export function ResponsiveFrame({ title, src, renderings, layout, zoom, tweaks, onDocHeight }: Props) {
  const { frame } = layout;
  return (
    <div data-responsive-frame className={styles.frame} style={{ width: frame.width, height: frame.height, ["--unit" as string]: 1 / zoom }}>
      {layout.renderings.map((box) => {
        const rendering = renderings.find((r) => renderingKey(r) === box.key)!;
        return (
          <div key={box.key} data-rendering={box.key} className={styles.rendering} style={{ left: box.x - frame.x, top: box.y - frame.y, width: box.width }}>
            <span className={styles.label} style={{ transform: `scale(${1 / zoom})` }}>
              {renderingLabel(rendering)}
            </span>
            <ArtboardFrame
              title={`${title} · ${renderingLabel(rendering)}`}
              src={src}
              width={box.width}
              height={box.height}
              zoom={zoom}
              threads={[]}
              picking={false}
              tweaks={tweaks}
              onPick={() => {}}
              onDocHeight={(height) => onDocHeight(box.key, height)}
            />
            <span className={styles.caption} style={{ transform: `scale(${1 / zoom})` }}>
              page de {formatPx(box.height)} px
            </span>
          </div>
        );
      })}
    </div>
  );
}
