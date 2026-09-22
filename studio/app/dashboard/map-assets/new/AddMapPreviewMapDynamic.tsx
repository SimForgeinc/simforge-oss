"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./AddMapPreviewMapDynamic.stylex";

import dynamic from "next/dynamic";
import { motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

type Bbox = { min_lat: number; min_lng: number; max_lat: number; max_lng: number };

type Props = {
  geojson: object | null;
  bbox: Bbox | null;
  onThumbnailReady?: (blob: Blob) => void;
};

const AddMapPreviewMap = dynamic(() => import("./AddMapPreviewMap"), {
  ssr: false,
  loading: () => <div {...stylex.props([motionRecipe.pulse, styles.mapPreviewLoadingPlaceholder])} />,
});

export default function AddMapPreviewMapDynamic(props: Props) {
  return <AddMapPreviewMap {...props} />;
}
