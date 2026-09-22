import Image from "next/image";
import * as stylex from "@stylexjs/stylex";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/** Every artwork file is a 640px square. */
const SOURCE = 640;

/**
 * The drawn content of one artwork file, in source pixels. The files carry
 * uneven transparent margins (Maps fills most of its square, Datasets sits low
 * and small), so fitting the files themselves made three unequal pictures.
 */
type ArtCrop = { x: number; y: number; width: number; height: number };

/**
 * The artwork tile of an app tab, keyed by the app's route. The images ship
 * with `@simforge-oss/studio-ui/public/app-switcher` and reach `public/` through
 * the asset sync, so the same files serve the desktop shell and the hosted app.
 * Crops are the alpha bounding boxes of those files.
 */
const APP_ART: Readonly<Record<string, { name: string; src: string; crop: ArtCrop }>> = {
  "/dashboard/map-assets": { name: "maps", src: "/app-switcher/maps-art-v1.png", crop: { x: 61, y: 77, width: 524, height: 441 } },
  "/dashboard/scenario": { name: "datasets", src: "/app-switcher/datasets-art-v1.png", crop: { x: 82, y: 132, width: 477, height: 376 } },
  "/dashboard/evaluation": { name: "evaluation", src: "/app-switcher/exports-art-v1.png", crop: { x: 116, y: 88, width: 435, height: 469 } },
  "/dashboard/assets": { name: "assets", src: "/app-switcher/assets.png", crop: { x: 0, y: 0, width: SOURCE, height: SOURCE } },
  "/dashboard/dataset-export": { name: "exports", src: "/app-switcher/exports-art-v1.png", crop: { x: 116, y: 88, width: 435, height: 469 } },
};

/**
 * Equal area rather than equal height: a wide picture drawn as tall as a
 * narrow one looks bigger. Each crop's height share is `1/sqrt(aspect)`,
 * scaled so the narrowest art (the tallest share) fills the frame.
 */
const TALLEST_SHARE = Math.max(
  ...Object.values(APP_ART).map(({ crop }) => 1 / Math.sqrt(crop.width / crop.height)),
);

const percent = (value: number) => `${(value * 100).toFixed(3)}%`;

export function AppSwitcherArt({ href }: { href: string }) {
  const art = APP_ART[href];
  if (!art) return null;
  const { crop } = art;
  const share = 1 / Math.sqrt(crop.width / crop.height) / TALLEST_SHARE;
  return (
    <span
      {...stylex.props(styles.artCrop)}
      style={{ height: percent(share), aspectRatio: `${crop.width} / ${crop.height}` }}
    >
      <Image
        alt=""
        aria-hidden="true"
        {...stylex.props(styles.artImage)}
        data-app-switcher-art={art.name}
        draggable={false}
        height={SOURCE}
        sizes="200px"
        src={art.src}
        style={{
          width: percent(SOURCE / crop.width),
          height: percent(SOURCE / crop.height),
          left: percent(-crop.x / crop.width),
          top: percent(-crop.y / crop.height),
        }}
        width={SOURCE}
      />
    </span>
  );
}
