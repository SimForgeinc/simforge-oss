"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { MapAsset } from "@simforge-oss/studio-shared";

interface UseMapAssetOperationsInput {
  currentAsset: MapAsset;
  onEnrichmentSucceeded: () => void;
  onRefreshMapAssets: () => void;
}

const FINALIZE_POLL_INTERVAL_MS = 2000;
const FINALIZE_POLL_TIMEOUT_MS = 10 * 60 * 1000;

type FinalizeOutcome = {
  status: "succeeded" | "failed" | "timeout" | "unknown";
  error?: string | null;
  result?: { candidate_location_count?: unknown; search_index_object_count?: unknown } | null;
};

/** Poll `/enrichment/status` until the given job leaves pending/running. */
async function waitForFinalizeJob(mapAssetId: string, jobId: string): Promise<FinalizeOutcome> {
  const deadline = Date.now() + FINALIZE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, FINALIZE_POLL_INTERVAL_MS);
    await tick.promise;
    const res = await fetch(`/api/map-assets/${mapAssetId}/enrichment/status`, { cache: "no-store" });
    if (!res.ok) continue;
    const body = (await res.json().catch(() => null)) as {
      jobs?: Array<{
        id: string;
        status: string;
        error_message?: string | null;
        result_json?: FinalizeOutcome["result"];
      }>;
    } | null;
    const job = body?.jobs?.find((entry) => entry.id === jobId);
    if (!job) return { status: "unknown" };
    if (job.status === "succeeded") return { status: "succeeded", result: job.result_json ?? null };
    if (job.status === "failed" || job.status === "timeout") {
      return { status: job.status, error: job.error_message ?? null };
    }
  }
  return { status: "timeout", error: "Map finalize is still running; refresh the page later." };
}

export function useMapAssetOperations({
  currentAsset,
  onEnrichmentSucceeded,
  onRefreshMapAssets,
}: UseMapAssetOperationsInput) {
  const [populatingMapId, setPopulatingMapId] = useState<string | null>(null);
  const [refreshingSearchIndexMapId, setRefreshingSearchIndexMapId] = useState<string | null>(null);
  const [populateErr, setPopulateErr] = useState<string | null>(null);
  const [enrichErr, setEnrichErr] = useState<string | null>(null);

  const populateBusy = populatingMapId === currentAsset.map_asset_id;
  const refreshSearchIndexBusy =
    refreshingSearchIndexMapId === currentAsset.map_asset_id;

  async function handlePopulateMetadata() {
    const targetId = currentAsset.map_asset_id;
    setPopulateErr(null);
    setPopulatingMapId(targetId);
    try {
      const res = await fetch(`/api/map-assets/${targetId}/populate-metadata`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        missing?: string[];
        enrichment_job_id?: string | null;
        enrichment_job_error?: string | null;
      };
      if (!res.ok) {
        const msg =
          body.detail ??
          body.error ??
          (body.missing?.length
            ? `Missing artifacts: ${body.missing.join(", ")}`
            : `Request failed (${res.status})`);
        setPopulateErr(msg);
        toast.error(msg);
        return;
      }

      toast.success(`Metadata populated for ${targetId}`);
      onRefreshMapAssets();
      if (body.enrichment_job_error) {
        setPopulateErr(body.enrichment_job_error);
        toast.error(body.enrichment_job_error);
        return;
      }
      if (body.enrichment_job_id) {
        // Candidate extraction and the search-index rebuild continue in the
        // finalize job; keep the button busy until it settles so the detail
        // page refreshes once the new sidecar exists.
        const outcome = await waitForFinalizeJob(targetId, body.enrichment_job_id);
        if (outcome.status === "succeeded") {
          const candidates = outcome.result?.candidate_location_count;
          const objects = outcome.result?.search_index_object_count;
          toast.success(
            typeof candidates === "number" && typeof objects === "number"
              ? `Map finalized — ${candidates} candidate locations, ${objects} search objects.`
              : "Map finalized.",
          );
        } else if (outcome.status !== "unknown") {
          const msg = outcome.error ?? `Map finalize ${outcome.status}.`;
          setPopulateErr(msg);
          toast.error(msg);
        }
      }
      onEnrichmentSucceeded();
      onRefreshMapAssets();
    } catch {
      const msg = "Network error while populating metadata.";
      setPopulateErr(msg);
      toast.error(msg);
    } finally {
      setPopulatingMapId((prev) => (prev === targetId ? null : prev));
    }
  }

  function handleEnrich() {
    const msg = "Third-party map enrichment is unavailable in local mode.";
    setEnrichErr(msg);
    toast.info(msg);
  }

  async function handleRefreshSearchIndex() {
    const targetId = currentAsset.map_asset_id;
    setRefreshingSearchIndexMapId(targetId);
    try {
      const res = await fetch(
        `/api/map-assets/${targetId}/refresh-search-index`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        object_count?: number;
        edge_count?: number;
      };
      if (!res.ok) {
        const msg =
          body.detail ?? body.error ?? `Refresh failed (${res.status})`;
        toast.error(msg);
        return;
      }
      const objectCount = body.object_count ?? 0;
      const edgeCount = body.edge_count ?? 0;
      toast.success(
        `Search index refreshed — ${objectCount} objects, ${edgeCount} edges.`,
      );
      onRefreshMapAssets();
    } catch {
      toast.error("Network error while refreshing the search index.");
    } finally {
      setRefreshingSearchIndexMapId((prev) =>
        prev === targetId ? null : prev,
      );
    }
  }

  return {
    populateBusy,
    enrichBusy: false,
    refreshSearchIndexBusy,
    populateErr,
    enrichErr,
    handlePopulateMetadata,
    handleEnrich,
    handleRefreshSearchIndex,
  };
}
