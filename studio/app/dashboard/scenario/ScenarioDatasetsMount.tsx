import type { ScenarioDatasetDto } from "@/app/lib/scenario/contracts";
"use client";

import { useEffect, useState } from "react";
import {
  ScenarioDatasetsClient,
  type DatasetCloudHome,
} from "@simforge-oss/studio-ui/scenario/ScenarioDatasetsClient";
import { cloudErrorMessage, studioCloud, useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * Supplies the dataset strip's cloud home section.
 *
 * `ScenarioDatasetsClient` is portable product code and cannot reach the SimCloud connection — that
 * lives in this host (`@/app/lib/host/cloud`), behind the same seam that keeps `studio-ui` free of
 * host imports. So the host resolves "which organization, and what does it own" here and hands the
 * answer down as data.
 *
 * A dataset has exactly one home (`docs/engineering/local-cloud-boundary.md` §2), so this reads the
 * organization's datasets straight from the organization. It deliberately does not consult
 * `cloud_dataset_links`: a link record is the mirror model the boundary document rejects, and
 * joining on it is what would put one dataset in two sections.
 */
function useDatasetCloudHome(): DatasetCloudHome {
  const { status } = useStudioCloudStatus();
  const [home, setHome] = useState<DatasetCloudHome>({ state: "loading" });
  // The provider re-reads status on a timer and on window focus, handing back a fresh object each
  // time. Depending on that object would refetch the organization's datasets on every poll, so the
  // effect depends on the three things that actually change the answer: the connection state, the
  // account identity behind it, and the message an errored connection carries.
  const state = status?.state ?? null;
  const message = status?.message ?? null;
  const identity =
    status?.state === "connected" ? `${status.user?.id}:${status.activeOrganizationId}` : null;

  useEffect(() => {
    if (state === null || state === "connecting") {
      setHome({ state: "loading" });
      return;
    }
    if (state === "error") {
      setHome({ state: "unavailable", message: message ?? "SimCloud could not be reached." });
      return;
    }
    if (state !== "connected") {
      setHome({ state: "signed-out" });
      return;
    }
    const abort = new AbortController();
    setHome({ state: "loading" });
    void (async () => {
      try {
        const organizations = await studioCloud.listOrganizations(abort.signal);
        // The first row, not a match against `status.activeOrganizationId`: those two ids are not
        // the same kind of identifier until the platform half of §8 step 2 lands, and
        // `StudioCloudOrganization`'s own docblock forbids comparing them. Choosing *which*
        // organization is account-settings work per §7, not the strip's.
        const organization = organizations[0];
        if (!organization) {
          setHome({
            state: "unavailable",
            message: "This account does not belong to a SimCloud organization yet.",
          });
          return;
        }
        const datasets = await studioCloud.listDatasets(organization.id, abort.signal);
        if (abort.signal.aborted) return;
        setHome({
          state: "connected",
          organizationName: organization.name,
          datasets,
          organizationCount: organizations.length,
        });
      } catch (reason) {
        if (abort.signal.aborted) return;
        setHome({
          state: "unavailable",
          message: cloudErrorMessage(reason, "This organization's datasets could not be read."),
        });
      }
    })();
    return () => abort.abort();
  }, [state, message, identity]);

  return home;
}

export function ScenarioDatasetsMount({
  initialDatasets,
}: {
  initialDatasets: ScenarioDatasetDto[];
}) {
  const cloudHome = useDatasetCloudHome();
  return <ScenarioDatasetsClient initialDatasets={initialDatasets} cloudHome={cloudHome} />;
}
