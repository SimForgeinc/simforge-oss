"use client";

/**
 * The runs rail: every prediction in the workspace, grouped by the scenario it
 * came from, with the runs this machine executed under their own heading.
 *
 * Cloud and local runs are two executors of one contract, so they belong in
 * one list — but they are not interchangeable (a local run has no cost, no
 * workspace and no cancel), which is why the machine's runs are a group rather
 * than rows mixed into the scenarios.
 */

import * as stylex from "@stylexjs/stylex";
import { Camera, Laptop, Plus } from "lucide-react";
import type { ComputeJob } from "@simforge-oss/studio-ui/evaluation";
import {
  groupRunsByScenario,
  JobStatusBadge,
  RailList,
  formatCents,
  type RailGroup,
} from "@simforge-oss/studio-ui/evaluation";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import type { ModelRunRecord } from "@/app/lib/models/contracts";
import { StatusBadge } from "../shared";
import { styles } from "./rails.stylex";

/** Two letters for the model, so a row is recognisable before it is read. */
function modelGlyph(family: string) {
  const parts = family.split(/[-.\s]+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "?"}${parts[1]?.[0] ?? ""}`;
}

export function RunRail({
  jobs,
  localRuns,
  scenarioTitles,
  selectedRunId,
  selectedLocalRunId,
  onSelectRun,
  onSelectLocalRun,
  onNewPrediction,
  workspacePicker,
}: {
  /** Null while the first page of cloud jobs is still loading. */
  jobs: ComputeJob[] | null;
  localRuns: ModelRunRecord[];
  scenarioTitles: ReadonlyMap<string, string>;
  selectedRunId: string | null;
  selectedLocalRunId: string | null;
  onSelectRun: (jobId: string) => void;
  onSelectLocalRun: (runId: string) => void;
  onNewPrediction: () => void;
  workspacePicker?: React.ReactNode;
}) {
  const groups: RailGroup[] = groupRunsByScenario(jobs ?? [], scenarioTitles).map((group) => ({
    key: group.key,
    label: group.title,
    rows: group.jobs.map((job) => ({
      id: job.id,
      testId: `run-row-${job.id}`,
      selected: job.id === selectedRunId,
      onSelect: () => onSelectRun(job.id),
      leading: (
        <span {...stylex.props(styles.glyph)} aria-hidden="true">
          {modelGlyph(job.model.family)}
          <Camera {...stylex.props(styles.glyphIcon)} />
        </span>
      ),
      title: job.kind === "alpamayo.text" ? "Text analysis" : "Open loop",
      meta: (
        <>
          <Badge variant="outline">{job.model.family}</Badge>
          <Badge variant="outline">{job.model.quant}</Badge>
          <JobStatusBadge job={job} />
          <span>{new Date(job.createdAt).toLocaleString()}</span>
        </>
      ),
      trailing: (
        <span {...stylex.props(styles.cost)}>
          {job.settledCents !== null ? formatCents(job.settledCents) : formatCents(job.reservedCents)}
        </span>
      ),
    })),
  }));

  if (localRuns.length > 0) {
    groups.push({
      key: "this-machine",
      label: "This machine",
      rows: localRuns.map((run) => ({
        id: run.id,
        testId: `local-run-row-${run.id}`,
        selected: run.id === selectedLocalRunId,
        onSelect: () => onSelectLocalRun(run.id),
        leading: (
          <span {...stylex.props(styles.glyph)} aria-hidden="true">
            <Laptop />
          </span>
        ),
        title: run.kind,
        meta: (
          <>
            <StatusBadge status={run.status} />
            <span>{new Date(run.createdAt).toLocaleString()}</span>
          </>
        ),
      })),
    });
  }

  const count = (jobs?.length ?? 0) + localRuns.length;

  return (
    <RailList
      title="Runs"
      count={jobs === null ? null : count}
      ariaLabel="Evaluation runs"
      actions={
        <div {...stylex.props(styles.actions)}>
          <Button type="button" size="sm" onClick={onNewPrediction} data-testid="new-prediction">
            <Plus aria-hidden="true" />
            New prediction
          </Button>
          {workspacePicker}
        </div>
      }
      groups={groups}
      empty={
        <EmptyState
          title={jobs === null ? "Loading runs…" : "No runs yet"}
          description="Runs you submit here and from the web portal both appear in this list, for everyone in the workspace."
        />
      }
    />
  );
}
