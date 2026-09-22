import Image from "next/image";
import * as stylex from "@stylexjs/stylex";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/**
 * The artwork tile of an app tab, keyed by the app's route. The images ship
 * with `@simforge-oss/studio-ui/public/app-switcher` and reach `public/` through
 * the asset sync, so the same files serve the desktop shell and the hosted app.
 */
const APP_ART: Readonly<Record<string, { name: string; src: string }>> = {
  "/dashboard/map-assets": { name: "maps", src: "/app-switcher/maps-art-v1.png" },
  "/dashboard/scenario": { name: "datasets", src: "/app-switcher/datasets-art-v1.png" },
  "/dashboard/evaluation": { name: "evaluation", src: "/app-switcher/exports-art-v1.png" },
  "/dashboard/assets": { name: "assets", src: "/app-switcher/assets.png" },
  "/dashboard/dataset-export": { name: "exports", src: "/app-switcher/exports-art-v1.png" },
};

export function AppSwitcherArt({ href }: { href: string }) {
  const art = APP_ART[href];
  if (!art) return null;
  return (
    <Image
      alt=""
      aria-hidden="true"
      {...stylex.props(styles.artImage)}
      data-app-switcher-art={art.name}
      draggable={false}
      height={640}
      sizes="220px"
      src={art.src}
      width={640}
    />
  );
}
