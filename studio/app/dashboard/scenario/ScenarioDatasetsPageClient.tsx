"use client";

import type { ScenarioDatasetDto } from "@/app/lib/scenario/contracts";
import { ScenarioDatasetsClient } from "@simforge-oss/studio-ui/scenario/ScenarioDatasetsClient";
import { useDatasetCloudHome } from "@/app/host";

export function ScenarioDatasetsPageClient({ initialDatasets }: { initialDatasets: ScenarioDatasetDto[] }) {
  const cloudHome = useDatasetCloudHome();
  return <ScenarioDatasetsClient initialDatasets={initialDatasets} cloudHome={cloudHome} />;
}
