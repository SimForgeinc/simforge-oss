import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";

export default function MapAssetsLoading() {
  return (
    <CloudLoadingSurface
      detail="Opening maps in your workspace."
      priority={11}
      progress={null}
      scope="screen"
      title="Loading map library…"
    />
  );
}
