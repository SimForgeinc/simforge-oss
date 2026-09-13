"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../../map-assets.stylex";

import { useState, useMemo, useCallback, useEffect, useRef, forwardRef } from "react";
import { ChevronRight, Loader2, X } from "lucide-react";
import type {
  MapAsset,
  MapAssetEnrichmentSnapshot,
  CandidateLocation,
} from "@simforge-oss/studio-shared";
import type { ScenarioSummary } from "@/app/lib/scenarios";
import { CandidateLocationCard } from "@/app/dashboard/map-assets/map-detail-sections/CandidateLocationCard";
import {
  buildScenarioFamilyGroups,
  humanizeTag,
  getAllCandidateTags,
  assignCandidateToFamily,
  type ScenarioFamilyGroup,
} from "@/app/lib/scenario-intelligence-ui";
import { getFamilyIcon } from "@/app/lib/scenario-family-icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@simforge-oss/studio-ui/components/ui/tooltip";

type ActiveFilter = { type: "family"; id: string } | { type: "tag"; id: string } | null;

interface InsightsTabProps {
  asset: MapAsset;
  runs: ScenarioSummary[];
  enrichment: MapAssetEnrichmentSnapshot | null;
  enrichmentLoading: boolean;
  candidateLocations: CandidateLocation[];
  candidateLocationsLoading: boolean;
  selectedCandidateLocationId: string | null;
  onSelectCandidateLocationId?: (id: string | null) => void;
  focusFamilyId?: string | null;
  onClearFocusFamily?: () => void;
}

/** Scenario insights tab showing family groups, candidate locations, and filters. */
export function InsightsTab({
  asset,
  runs: _runs,
  enrichment: _enrichment,
  enrichmentLoading: _enrichmentLoading,
  candidateLocations,
  candidateLocationsLoading,
  selectedCandidateLocationId,
  onSelectCandidateLocationId,
  focusFamilyId,
  onClearFocusFamily,
}: InsightsTabProps) {
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(null);

  const tags = useMemo(() => asset.tags ?? [], [asset.tags]);
  const familyGroups = useMemo(
    () => buildScenarioFamilyGroups(tags, candidateLocations),
    [tags, candidateLocations],
  );

  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const familyRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!focusFamilyId) return;
    setExpandedFamilies((prev) => {
      if (prev.has(focusFamilyId)) return prev;
      return new Set([...prev, focusFamilyId]);
    });
    requestAnimationFrame(() => {
      familyRefs.current.get(focusFamilyId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    onClearFocusFamily?.();
  }, [focusFamilyId, onClearFocusFamily]);

  const toggleFamily = useCallback((id: string) => {
    setExpandedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sortedCandidates = useMemo(() => {
    return [...candidateLocations].sort((a, b) => {
      if (a.rank != null && b.rank != null) return a.rank - b.rank;
      if (a.rank != null) return -1;
      if (b.rank != null) return 1;
      return b.confidence - a.confidence;
    });
  }, [candidateLocations]);

  const filteredCandidates = useMemo(() => {
    if (!activeFilter) return sortedCandidates;
    if (activeFilter.type === "family") {
      return sortedCandidates.filter((c) => assignCandidateToFamily(c).id === activeFilter.id);
    }
    return sortedCandidates.filter((c) => getAllCandidateTags(c).includes(activeFilter.id));
  }, [sortedCandidates, activeFilter]);

  return (
    <div className={stylex.props(styles.s_993).className}>
      {familyGroups.length > 0 && (
        <section>
          <h3 className={stylex.props(styles.s_959).className}>
            Scenario Families
          </h3>
          <div className={stylex.props(styles.s_960).className}>
            {familyGroups.map((group) => (
              <ScenarioFamilyCard
                key={group.family.id}
                ref={(el) => {
                  if (el) familyRefs.current.set(group.family.id, el);
                  else familyRefs.current.delete(group.family.id);
                }}
                group={group}
                expanded={expandedFamilies.has(group.family.id)}
                onToggle={() => toggleFamily(group.family.id)}
                selectedCandidateLocationId={selectedCandidateLocationId}
                onSelectCandidateLocationId={onSelectCandidateLocationId}
                loading={candidateLocationsLoading}
              />
            ))}
          </div>
        </section>
      )}

      {(candidateLocations.length > 0 || candidateLocationsLoading) && (
        <section>
          <div className={stylex.props(styles.s_961).className}>
            <button
              type="button"
              onClick={() => setExplorerOpen((o) => !o)}
              className={stylex.props(styles.s_962).className}
              aria-expanded={explorerOpen}
            >
              <ChevronRight
                className={stylex.props(styles.chevron, explorerOpen && styles.rotate90).className}
              />
              Candidate Locations
              {candidateLocationsLoading ? (
                <span className={stylex.props(styles.s_979).className}>
                  <Loader2 className={stylex.props(styles.s_980).className} aria-hidden="true" />
                  <span>Loading…</span>
                </span>
              ) : candidateLocations.length > 0 ? (
                <span className={stylex.props(styles.s_965).className}>
                  {activeFilter ? `${filteredCandidates.length}/${candidateLocations.length}` : candidateLocations.length}
                </span>
              ) : null}
            </button>
            {activeFilter && (
              <button
                type="button"
                onClick={() => setActiveFilter(null)}
                className={stylex.props(styles.s_966).className}
              >
                {activeFilter.type === "family"
                  ? familyGroups.find((g) => g.family.id === activeFilter.id)?.family.name ?? activeFilter.id
                  : humanizeTag(activeFilter.id)}
                <X className={stylex.props(styles.s_967).className} />
              </button>
            )}
          </div>

          {explorerOpen && (
            <div className={stylex.props(styles.s_968).className}>
              <div className={stylex.props(styles.s_969).className}>
                {familyGroups.map((group) => {
                  const isActive = activeFilter?.type === "family" && activeFilter.id === group.family.id;
                  return (
                    <button
                      key={group.family.id}
                      type="button"
                      onClick={() =>
                        setActiveFilter(isActive ? null : { type: "family", id: group.family.id })
                      }
                      className={stylex.props(styles.insightChip, isActive ? styles.insightChipActive : styles.insightChipIdle).className}
                    >
                      {group.family.name}
                      {!candidateLocationsLoading && (
                        <>
                          {" "}
                          <span className={stylex.props(styles.s_970).className}>({group.candidates.length})</span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>

              {candidateLocationsLoading ? (
                <p className={stylex.props(styles.s_971).className}>
                  <Loader2 className={stylex.props(styles.s_972).className} /> Loading…
                </p>
              ) : filteredCandidates.length === 0 ? (
                <p className={stylex.props(styles.s_973).className}>
                  {activeFilter ? "No candidates match this filter." : "No candidate locations computed yet."}
                </p>
              ) : (
                <ul className={stylex.props(styles.s_986).className}>
                  {filteredCandidates.map((candidate) => (
                    <li key={candidate.id}>
                      <CandidateLocationCard
                        candidate={candidate}
                        selected={selectedCandidateLocationId === candidate.id}
                        onSelect={(id) => onSelectCandidateLocationId?.(id)}
                        family={assignCandidateToFamily(candidate)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

    </div>
  );
}

interface ScenarioFamilyCardProps {
  group: ScenarioFamilyGroup;
  expanded: boolean;
  onToggle: () => void;
  selectedCandidateLocationId: string | null;
  onSelectCandidateLocationId?: (id: string | null) => void;
  loading?: boolean;
}

const ScenarioFamilyCard = forwardRef<HTMLDivElement, ScenarioFamilyCardProps>(
  function ScenarioFamilyCard({
    group,
    expanded,
    onToggle,
    selectedCandidateLocationId,
    onSelectCandidateLocationId,
    loading = false,
  }, ref) {
    const Icon = getFamilyIcon(group.family);
    const tagTooltip = group.tags.length > 0
      ? group.tags.map((t) => `${t.display}${t.candidateCount > 0 ? ` (${t.candidateCount})` : ""}`).join("\n")
      : null;

    return (
      <div ref={ref} className={stylex.props(styles.s_975).className}>
        <button
          type="button"
          onClick={onToggle}
          className={stylex.props(styles.s_976).className}
        >
          <ChevronRight
            className={stylex.props(styles.chevronMutedShrink, expanded && styles.rotate90).className}
          />
          <Icon className={stylex.props(styles.s_977).className} />
          <span className={stylex.props(styles.s_978).className}>{group.family.name}</span>
          {loading ? (
            <span className={stylex.props(styles.s_979).className}>
              <Loader2 className={stylex.props(styles.s_980).className} aria-hidden="true" />
              <span>Loading…</span>
            </span>
          ) : (
            <span className={stylex.props(styles.s_981).className}>
              {group.candidates.length} location{group.candidates.length !== 1 ? "s" : ""}
            </span>
          )}
        </button>

        {expanded && (
          <div className={stylex.props(styles.s_982).className}>
            {tagTooltip ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className={stylex.props(styles.s_983, styles.stackY2_5).className}>
                      {group.family.description}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" xstyle={styles.s_984}>
                    {tagTooltip}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <p className={stylex.props(styles.s_985, styles.stackY2_5).className}>{group.family.description}</p>
            )}

            {group.candidates.length > 0 && (
              <ul className={stylex.props(styles.s_986, styles.stackY2_5).className}>
                {group.candidates.map((candidate: CandidateLocation) => (
                  <li key={candidate.id}>
                    <CandidateLocationCard
                      candidate={candidate}
                      selected={selectedCandidateLocationId === candidate.id}
                      onSelect={(id) => onSelectCandidateLocationId?.(id)}
                      compact
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  },
);
