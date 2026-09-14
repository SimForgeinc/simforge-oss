import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";

export default function DashboardLoading() {
  return (
    <CloudLoadingSurface
      detail="Opening dashboard in your workspace."
      priority={10}
      progress={null}
      scope="screen"
      title="Loading your workspace…"
    />
  );
}
