import type { CatalogId } from "@simforge-oss/asset-catalog";

import { Adult, Child, TrafficMarshal } from "./actor-art/pedestrians";

export const PEDESTRIAN_CATALOG_IDS = [
  "pedestrian.adult",
  "pedestrian.child",
  "pedestrian.traffic_marshal",
] as const satisfies readonly CatalogId[];

export type PedestrianCatalogId = (typeof PEDESTRIAN_CATALOG_IDS)[number];

/**
 * One drawing per person. Adults and children differ in height and in
 * head-to-body ratio, and the marshal carries his kit, so a scenario's crowd
 * is readable at tile size instead of three identical figures. Shared
 * geometry and palette live in `vehicle-art/parts.tsx`.
 */
const PEDESTRIAN_ART: Readonly<
  Record<PedestrianCatalogId, () => React.ReactElement>
> = {
  "pedestrian.adult": Adult,
  "pedestrian.child": Child,
  "pedestrian.traffic_marshal": TrafficMarshal,
};

/** Side-elevation artwork for one catalog pedestrian. */
export function PedestrianCatalogIcon({ id }: { id: PedestrianCatalogId }) {
  const Art = PEDESTRIAN_ART[id];
  return <Art />;
}
