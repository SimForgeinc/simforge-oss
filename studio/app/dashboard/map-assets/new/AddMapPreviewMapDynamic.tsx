"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import dynamic from "next/dynamic";

type Bbox = { min_lat: number; min_lng: number; max_lat: number; max_lng: number };

type Props = {
  geojson: object | null;
  bbox: Bbox | null;
  onThumbnailReady?: (blob: Blob) => void;
};

const AddMapPreviewMap = dynamic(() => import("./AddMapPreviewMap"), {
  ssr: false,
  loading: () => <div className={stylex.props(styles.s_289).className} />,
});

export default function AddMapPreviewMapDynamic(props: Props) {
  return <AddMapPreviewMap {...props} />;
}
