import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";

export default function MapDetailLoading() {
  return (
    <CloudLoadingSurface
      detail="Opening map in your workspace."
      priority={12}
      progress={null}
      scope="screen"
      title="Loading map details…"
    />
  );
}
