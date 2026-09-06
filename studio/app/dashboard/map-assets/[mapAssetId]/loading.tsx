import { RouteLoading } from "@simforge-oss/studio-ui/components/ui/sim-loader";

export default function MapDetailLoading() {
  return <RouteLoading depth={2} label="Map" detail="Loading map details…" />;
}
