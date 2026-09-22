"use client";
import { ListSkeleton } from "@simforge-oss/studio-ui/components/ListSkeleton";

/**
 * The campaigns rail. The open campaign expands its policies inline, because a
 * policy is only meaningful under its campaign: selecting one is narrowing the
 * stage, not navigating away from it.
 */

import * as stylex from "@stylexjs/stylex";
import { RailList, type RailGroup } from "@simforge-oss/studio-ui/evaluation";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import type { EvalCampaignSummary } from "@/app/lib/evaluation/contracts";
import { formatScore } from "../shared";
import { styles } from "./rails.stylex";

export function CampaignRail({
  campaigns,
  loading,
  selectedCampaignId,
  selectedPolicyId,
  onSelectCampaign,
  onSelectPolicy,
}: {
  campaigns: EvalCampaignSummary[];
  loading: boolean;
  selectedCampaignId: string | null;
  selectedPolicyId: string | null;
  onSelectCampaign: (campaignId: string) => void;
  onSelectPolicy: (campaignId: string, policyId: string) => void;
}) {
  const groups: RailGroup[] = [
    {
      key: "campaigns",
      rows: campaigns.map((campaign) => ({
        id: campaign.campaignId,
        testId: `campaign-${campaign.campaignId}`,
        selected: campaign.campaignId === selectedCampaignId && selectedPolicyId === null,
        onSelect: () => onSelectCampaign(campaign.campaignId),
        title: campaign.name,
        meta: (
          <>
            <span>
              {campaign.episodes} {campaign.episodes === 1 ? "episode" : "episodes"}
            </span>
            <span>
              {campaign.policies.length} {campaign.policies.length === 1 ? "policy" : "policies"}
            </span>
            {campaign.hasReport ? (
              <span {...stylex.props(styles.reportDot)} title="Report ready" aria-label="Report ready" />
            ) : null}
          </>
        ),
        children:
          campaign.campaignId === selectedCampaignId
            ? campaign.policies.map((policy) => ({
                id: `${campaign.campaignId}:${policy.policyId}`,
                testId: `campaign-policy-${policy.policyId}`,
                selected: policy.policyId === selectedPolicyId,
                onSelect: () => onSelectPolicy(campaign.campaignId, policy.policyId),
                title: policy.policyId,
                meta: (
                  <>
                    <span>score {formatScore(policy.meanScore)}</span>
                    <span>{policy.episodes} ep</span>
                  </>
                ),
              }))
            : undefined,
      })),
    },
  ];

  return (
    <RailList
      title="Campaigns"
      count={loading ? null : campaigns.length}
      ariaLabel="Evaluation campaigns"
      groups={groups}
      empty={loading ? <ListSkeleton label="Loading evaluation list" /> : <EmptyState title="No eval campaigns yet" description="Campaigns group policy runs and their retained evidence." />}
    />
  );
}
