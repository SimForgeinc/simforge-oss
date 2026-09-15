"use client";

/**
 * One campaign, as a score board.
 *
 * The campaign used to be a table of policies inside a card. A table asks the
 * reader to compare numbers across rows by eye; the thing they actually want
 * to know — which model drove better, and by how much — is a length. So each
 * policy is a bar of its mean driving score with route completion under it,
 * and the exact figures stay beside them for the reader who needs them.
 */

import * as stylex from "@stylexjs/stylex";
import { GitCompareArrows } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import type { EvalCampaignSummary } from "@/app/lib/evaluation/contracts";
import { formatScore } from "../shared";
import { styles as residual } from "../route-residuals.stylex";
import { styles } from "./CampaignStage.stylex";

/** A mean is a fraction; anything outside 0..1 is a bad reading, not a long bar. */
function barWidth(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0%";
  return `${String(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function CampaignStage({
  campaign,
  selectedPolicyId,
  onSelectPolicy,
  onSelectVersion,
  onCompare,
}: {
  campaign: EvalCampaignSummary;
  selectedPolicyId: string | null;
  onSelectPolicy: (policyId: string) => void;
  onSelectVersion: (versionId: string) => void;
  /** Enter compare mode with these columns; the first is the baseline. */
  onCompare: (policyIds: string[]) => void;
}) {
  const [policyA, policyB] = campaign.policies;

  return (
    <div {...stylex.props(residual.content)} data-testid={`campaign-stage-${campaign.campaignId}`}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.heading)}>
          <h1 {...stylex.props(styles.title)}>{campaign.name}</h1>
          <p {...stylex.props(styles.subtitle)}>
            {campaign.campaignId} · {campaign.episodes} episodes
            {campaign.createdAt ? ` · created ${new Date(campaign.createdAt).toLocaleString()}` : ""}
            {campaign.hasReport ? " · report ready" : ""}
          </p>
        </div>
        {policyA && policyB ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onCompare([policyA.policyId, policyB.policyId])}
          >
            <GitCompareArrows {...stylex.props(residual.icon)} />
            Compare models
          </Button>
        ) : null}
      </div>

      {campaign.policies.length === 0 ? (
        <EmptyState
          title="No completed policies yet"
          description="A policy appears here once its first episode lands in the campaign ledger."
        />
      ) : (
        <div {...stylex.props(styles.board)}>
          {campaign.policies.map((policy) => (
            <button
              key={policy.policyId}
              type="button"
              onClick={() => onSelectPolicy(policy.policyId)}
              data-testid={`campaign-score-${policy.policyId}`}
              {...stylex.props(
                styles.scoreRow,
                policy.policyId === selectedPolicyId ? styles.scoreRowSelected : null,
              )}
            >
              <span {...stylex.props(styles.policy)}>
                <span {...stylex.props(styles.policyId)}>{policy.policyId}</span>
                <span {...stylex.props(styles.policyMeta)}>
                  {policy.episodes} episodes · {policy.infractionEpisodes} with infractions
                </span>
              </span>

              <span {...stylex.props(styles.bars)}>
                <span {...stylex.props(styles.barTrack)}>
                  <span
                    {...stylex.props(styles.barFillScore)}
                    style={{ width: barWidth(policy.meanScore) }}
                  />
                </span>
                <span {...stylex.props(styles.barTrack)}>
                  <span
                    {...stylex.props(styles.barFillRoute)}
                    style={{ width: barWidth(policy.meanRouteCompletion) }}
                  />
                </span>
                <span {...stylex.props(styles.barLegend)}>
                  <span>driving score {formatScore(policy.meanScore)}</span>
                  <span>route {formatScore(policy.meanRouteCompletion)}</span>
                </span>
              </span>

              <span {...stylex.props(styles.numbers)}>
                <span>{formatScore(policy.meanScore)}</span>
                {policy.modelVersionId ? (
                  <span
                    role="link"
                    tabIndex={0}
                    {...stylex.props(styles.versionLink)}
                    onClick={(event) => {
                      // The row opens the policy; this opens the model behind it.
                      event.stopPropagation();
                      onSelectVersion(policy.modelVersionId!);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectVersion(policy.modelVersionId!);
                    }}
                  >
                    {policy.modelVersionId.slice(0, 12)}…
                  </span>
                ) : (
                  <span {...stylex.props(styles.policyMeta)}>unregistered</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
