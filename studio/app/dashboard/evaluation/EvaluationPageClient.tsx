"use client";

/**
 * The evaluation workspace on the desktop.
 *
 * One page, three columns: the section strip, a rail of what exists, and the
 * stage that shows the one thing selected. What is open is query state written
 * with `replaceState`, not a route — opening a run must not re-run a server
 * component, and the six screens this replaced were six full page loads around
 * the same data.
 *
 * This client owns the data every section reads and nothing else: the rails
 * render lists, the stages render one thing, and neither fetches what the
 * other already has.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import { SelectMenu } from "@simforge-oss/studio-ui/components/ui/select-menu";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import {
  EvaluationShell,
  LaunchStage,
  RefusalNotice,
  jobStatusPresentation,
  sourceRenderJobIds,
  useEvaluationSelection,
  useJobList,
  type EvaluationSelection,
  type LocalRunLauncher,
} from "@simforge-oss/studio-ui/evaluation";
import type { StudioCloudOrganization } from "@simforge-oss/studio-host";
import type { EvalCampaignSummary } from "@/app/lib/evaluation/contracts";
import type { ModelRunRecord, ModelVersionRecord } from "@/app/lib/models/contracts";
import { useEvaluationGateway, useHostExecutionSnapshot } from "@/app/lib/host/evaluation";
import { LocalRunUnavailable, startLocalRun } from "@/app/lib/host/local-runs";
import { CampaignRail } from "./rails/CampaignRail";
import { ModelRail } from "./rails/ModelRail";
import { RunRail } from "./rails/RunRail";
import { useScenarioTitles } from "./rails/useScenarioTitles";
import { CampaignStage } from "./stages/CampaignStage";
import { CompareClient } from "./stages/CompareClient";
import { EpisodePlaybackClient } from "./stages/EpisodePlaybackClient";
import { LocalRunClient } from "./stages/LocalRunClient";
import { PolicyDetailClient } from "./stages/PolicyDetailClient";
import { RunDetailClient } from "./stages/RunDetailClient";
import { VersionDetailClient } from "./stages/VersionDetailClient";
import { useJsonFetch } from "./shared";
import { styles } from "./evaluation-page.stylex";

export function EvaluationPageClient() {
  const { selection, select, selectSection } = useEvaluationSelection();
  const [organizations, setOrganizations] = useState<StudioCloudOrganization[] | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localRunsRefresh, setLocalRunsRefresh] = useState(0);
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);

  const gateway = useEvaluationGateway(organizationId);
  const host = useHostExecutionSnapshot(organizationId);
  const { jobs, error: jobsError } = useJobList(gateway, submittedJobId);

  const localRuns = useJsonFetch<{ runs: ModelRunRecord[] }>("/api/models/runs", localRunsRefresh);
  const campaigns = useJsonFetch<{ campaigns: EvalCampaignSummary[] }>("/api/evaluation/campaigns");
  const versions = useJsonFetch<{ versions: ModelVersionRecord[] }>("/api/models/versions");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/simforge/cloud/organizations", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | { organizations?: StudioCloudOrganization[]; error?: string }
          | null;
        // No SimCloud session is the ordinary state of a desktop that has not
        // connected one, not a failure. There is simply no organization to
        // pick, and the launcher already says how to connect an account.
        // Reporting it as an error pinned a permanent banner over the stage on
        // every such machine.
        if (response.status === 401 || payload?.error === "cloud_disconnected") {
          setOrganizations([]);
          return;
        }
        if (!response.ok) throw new Error(`organizations request failed (${response.status})`);
        setOrganizations(payload?.organizations ?? []);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setOrganizations([]);
        setError(
          cause instanceof Error
            ? `Your SimCloud organizations could not be listed: ${cause.message}`
            : "Your SimCloud organizations could not be listed.",
        );
      });
    return () => controller.abort();
  }, []);

  const renderJobIds = useMemo(() => sourceRenderJobIds(jobs ?? []), [jobs]);
  const scenarioTitles = useScenarioTitles(renderJobIds);

  const localRunList = localRuns.kind === "ready" ? localRuns.data.runs : [];
  const campaignList = campaigns.kind === "ready" ? campaigns.data.campaigns : [];
  const versionList = versions.kind === "ready" ? versions.data.versions : [];

  const selectRun = useCallback((jobId: string) => select({ section: "runs", run: jobId }), [select]);

  /**
   * Start the run on this machine. Local execution is a real path, not a label:
   * the inputs are staged on disk, the local model-run queue leases the run, and
   * the worker writes the same result manifest a cloud run produces.
   */
  const runLocally = useCallback<LocalRunLauncher>(
    async ({ selection: model, prepared, params }) => {
      try {
        const started = await startLocalRun({
          family: model.family,
          quant: model.quant,
          files: prepared.sourceFiles,
          params,
          seed: typeof params.seed === "number" ? params.seed : 0,
        });
        setError(null);
        setLocalRunsRefresh((key) => key + 1);
        select({ section: "runs", local: started.runId });
      } catch (cause) {
        setError(
          cause instanceof LocalRunUnavailable
            ? cause.message
            : `The local run could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [select],
  );

  const selectedCampaign =
    selection.section === "campaigns" && selection.campaign
      ? (campaignList.find((entry) => entry.campaignId === selection.campaign) ?? null)
      : null;
  const selectedVersion =
    selection.section === "models" && selection.version
      ? (versionList.find((entry) => entry.id === selection.version) ?? null)
      : null;
  const selectedJob =
    selection.section === "runs" && selection.run
      ? ((jobs ?? []).find((job) => job.id === selection.run) ?? null)
      : null;

  const pageTitle =
    selection.section === "campaigns"
      ? (selectedCampaign?.name ?? "Campaigns")
      : selection.section === "models"
        ? (selectedVersion?.name ?? "Models")
        : selectedJob
          ? `${selectedJob.model.family} run`
          : "Evaluation";
  useSetPageTitle(pageTitle);

  const rail =
    selection.section === "campaigns" ? (
      <CampaignRail
        campaigns={campaignList}
        loading={campaigns.kind === "loading"}
        selectedCampaignId={selection.campaign ?? null}
        selectedPolicyId={selection.policy ?? null}
        onSelectCampaign={(campaignId) => select({ section: "campaigns", campaign: campaignId })}
        onSelectPolicy={(campaignId, policyId) =>
          select({ section: "campaigns", campaign: campaignId, policy: policyId })
        }
      />
    ) : selection.section === "models" ? (
      <ModelRail
        versions={versionList}
        loading={versions.kind === "loading"}
        selectedVersionId={selection.version ?? null}
        onSelectVersion={(versionId) => select({ section: "models", version: versionId })}
      />
    ) : (
      <RunRail
        jobs={jobs}
        listError={jobsError}
        localRuns={localRunList}
        scenarioTitles={scenarioTitles}
        selectedRunId={selection.run ?? null}
        selectedLocalRunId={selection.local ?? null}
        onSelectRun={selectRun}
        onSelectLocalRun={(runId) => select({ section: "runs", local: runId })}
        onNewPrediction={() => select({ section: "runs" })}
        organizationPicker={
          organizations && organizations.length > 0 ? (
            <div {...stylex.props(styles.organization)}>
              <span {...stylex.props(styles.organizationLabel)}>Organization</span>
              <SelectMenu
                label="SimCloud organization"
                value={organizationId ?? ""}
                options={[
                  { value: "", label: "Active account organization" },
                  ...organizations.map((organization) => ({
                    value: organization.id,
                    label: `${organization.name} (${organization.role})`,
                  })),
                ]}
                onChange={(value) => setOrganizationId(value || null)}
              />
            </div>
          ) : null
        }
      />
    );

  // The overlay carries what an action did, not what a source is: a failed
  // list belongs in the rail that shows the list, and a banner that never
  // clears is a click shield rather than a message.

  function renderStage() {
    if (selection.section === "models") {
      if (!selection.version) {
        return versions.kind === "loading" ? (
          <CloudLoadingSurface scope="pane" title="Loading models" detail="Reading the local model registry." />
        ) : (
          <EmptyState
            xstyle={styles.stagePad}
            title="Pick a model version"
            description="A version's detail shows its provenance, its eval runs and the promotion gate."
          />
        );
      }
      return <VersionDetailClient versionId={selection.version} />;
    }

    if (selection.section === "campaigns") {
      if (!selection.campaign) {
        return campaigns.kind === "loading" ? (
          <CloudLoadingSurface scope="pane" title="Loading campaigns" detail="Reading the runs root." />
        ) : (
          <EmptyState
            xstyle={styles.stagePad}
            title="Pick a campaign"
            description="Campaign ledgers are read from the runs root (simforge-assets/runs/<campaignId>/ledger.jsonl)."
          />
        );
      }
      const campaignId = selection.campaign;
      if (selection.compare) {
        return (
          <CompareClient
            campaignId={campaignId}
            policies={selection.compare}
            onSelectPolicy={(policyId) =>
              select({ section: "campaigns", campaign: campaignId, policy: policyId })
            }
            onSelectEpisode={(episodeId) =>
              select({ section: "campaigns", campaign: campaignId, episode: episodeId })
            }
            onSelectCampaign={(next) => select({ section: "campaigns", campaign: next })}
          />
        );
      }
      if (selection.episode) {
        return (
          <EpisodePlaybackClient
            campaignId={campaignId}
            episodeId={selection.episode}
            onSelectPolicy={(policyId) =>
              select({ section: "campaigns", campaign: campaignId, policy: policyId })
            }
          />
        );
      }
      if (selection.policy) {
        return (
          <PolicyDetailClient
            campaignId={campaignId}
            policyId={selection.policy}
            onSelectEpisode={(episodeId) =>
              select({
                section: "campaigns",
                campaign: campaignId,
                policy: selection.policy,
                episode: episodeId,
              })
            }
            onSelectVersion={(versionId) => select({ section: "models", version: versionId })}
          />
        );
      }
      if (!selectedCampaign) {
        return campaigns.kind === "loading" ? (
          <CloudLoadingSurface scope="pane" title="Loading campaign" detail="Reading the runs root." />
        ) : (
          <EmptyState
            xstyle={styles.stagePad}
            title="This campaign is not in the runs root"
            description={`No ledger was found for ${campaignId}.`}
          />
        );
      }
      return (
        <CampaignStage
          campaign={selectedCampaign}
          selectedPolicyId={null}
          onSelectPolicy={(policyId) =>
            select({ section: "campaigns", campaign: campaignId, policy: policyId })
          }
          onSelectVersion={(versionId) => select({ section: "models", version: versionId })}
          onCompare={(policyIds) =>
            select({ section: "campaigns", campaign: campaignId, compare: policyIds })
          }
        />
      );
    }

    if (selection.run) return <RunDetailClient jobId={selection.run} />;
    if (selection.local) return <LocalRunClient runId={selection.local} />;
    // A failed list is not a loading list: the organization may have no SimCloud
    // account at all, and starting a run is still the thing to offer. The
    // failure itself is on the overlay.
    if (jobs === null && !jobsError) {
      return (
        <CloudLoadingSurface
          scope="pane"
          title="Loading runs"
          detail="Reading this organization's evaluation runs."
        />
      );
    }
    return (
      <LaunchStage
        gateway={gateway}
        host={host}
        runtime={null}
        onSubmitted={(job) => {
          setSubmittedJobId(job.id);
          selectRun(job.id);
        }}
        onRunLocally={runLocally}
        recent={(jobs ?? []).filter((job) => !jobStatusPresentation(job.status).live)}
        onSelectRun={selectRun}
      />
    );
  }

  const stage = renderStage();
  return (
    <EvaluationShell
      section={selection.section}
      onSectionChange={selectSection}
      rail={rail}
      stage={stage}
      overlay={
        error ? (
          <>
            <span {...stylex.props(styles.overlayMessage)}>{error}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                setLocalRunsRefresh((key) => key + 1);
              }}
            >
              Try again
            </Button>
          </>
        ) : null
      }
    />
  );
}
