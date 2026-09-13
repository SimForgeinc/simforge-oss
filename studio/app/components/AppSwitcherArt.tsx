import Image from "next/image";
import * as stylex from "@stylexjs/stylex";
import {
  mergeStyleProps,
  type XStyle,
} from "@simforge-oss/studio-ui/components/stylex";

type AppSwitcherArtProps = {
  href: string;
  /** Caller-supplied Tailwind classes, kept for callers still on utilities. */
  className?: string;
  /** Caller-supplied StyleX styles; applied before `className` so it wins. */
  xstyle?: XStyle;
};

const APP_ART = {
  "/dashboard/map-assets": {
    name: "maps",
    src: "/app-switcher/maps-art-v1.png",
  },
  "/dashboard/assets": {
    name: "assets",
    src: "/app-switcher/assets.png",
  },
  "/dashboard/scenario": {
    name: "datasets",
    src: "/app-switcher/datasets-art-v1.png",
  },
  "/dashboard/dataset-export": {
    name: "exports",
    src: "/app-switcher/exports-art-v1.png",
  },
} as const;

export function AppSwitcherArt({ href, className, xstyle }: AppSwitcherArtProps) {
  const art =
    APP_ART[href as keyof typeof APP_ART] ??
    APP_ART["/dashboard/dataset-export"];

  return (
    <Image
      alt=""
      aria-hidden="true"
      {...mergeStyleProps(stylex.props(xstyle), className)}
      data-app-switcher-art={art.name}
      draggable={false}
      height={640}
      sizes="160px"
      src={art.src}
      width={640}
    />
  );
}
