"use client";
import { ListSkeleton } from "@simforge-oss/studio-ui/components/ListSkeleton";

/** The model registry rail: one row per registered version, promotion state visible. */

import * as stylex from "@stylexjs/stylex";
import { RailList, type RailGroup } from "@simforge-oss/studio-ui/evaluation";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import type { ModelVersionRecord } from "@/app/lib/models/contracts";
import { StatusBadge } from "../shared";
import { styles } from "./rails.stylex";

export function ModelRail({
  versions,
  loading,
  selectedVersionId,
  onSelectVersion,
}: {
  versions: ModelVersionRecord[];
  loading: boolean;
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
}) {
  const groups: RailGroup[] = [
    {
      key: "versions",
      rows: versions.map((version) => ({
        id: version.id,
        testId: `model-version-${version.id}`,
        selected: version.id === selectedVersionId,
        onSelect: () => onSelectVersion(version.id),
        title: version.name,
        meta: (
          <>
            <span>{version.family}</span>
            <Badge variant="secondary">{version.quant}</Badge>
            <StatusBadge status={version.status} />
          </>
        ),
        trailing: version.promotedRunId ? (
          <span {...stylex.props(styles.promoted)}>promoted</span>
        ) : undefined,
      })),
    },
  ];

  return (
    <RailList
      title="Models"
      count={loading ? null : versions.length}
      ariaLabel="Model versions"
      groups={groups}
      empty={loading ? <ListSkeleton label="Loading evaluation list" /> : <EmptyState title="No registered model versions" description="Versions appear here once a checkpoint is registered in the model registry." />}
    />
  );
}
