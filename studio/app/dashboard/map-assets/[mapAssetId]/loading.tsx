import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";

export default function MapDetailLoading() {
  return (
    <CloudLoadingSurface
      detail="Opening map in your workspace."
      priority={12}
      progress={null}
      progressLabel="Cloud workspace"
      scope="screen"
      title="Loading map details…"
    />
  );
}
