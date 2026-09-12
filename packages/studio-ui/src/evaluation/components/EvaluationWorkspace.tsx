"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { mergeStyleProps } from "../../components/stylex/surface";
import type { ComputeJob } from "../contracts";
import type { EvaluationGateway } from "../gateway";
import type { HostExecutionSnapshot, ModelRuntimeSnapshot } from "../presentation";
import { EvaluationLauncher, type LocalRunLauncher } from "./EvaluationLauncher";
import { JobHistory } from "./JobHistory";
import { styles as s } from "./evaluation-components.stylex";

export function EvaluationWorkspace({ gateway, host, runtime, onOpenJob, onRunLocally, notice, className }: {
  gateway: EvaluationGateway; host: HostExecutionSnapshot; runtime: ModelRuntimeSnapshot | null;
  onOpenJob: (jobId: string) => void; onRunLocally?: LocalRunLauncher; notice?: ReactNode; className?: string;
}) {
  const [lastSubmitted, setLastSubmitted] = useState<ComputeJob | null>(null);
  const root = stylex.props(s.section10);
  return <div {...mergeStyleProps(root, className)} data-testid="evaluation-workspace">
    {notice}
    <section {...stylex.props(s.section5)}><div {...stylex.props(s.stack1)}><h1 {...stylex.props(s.titleMd)}>Predict from uploaded video</h1><p {...stylex.props(s.max3xl, s.textSm, s.leading6, s.textMuted)}>Upload one driving video or synchronized camera views, then run AlpaMayo 1.5 or 2 Super. The durable result includes a playable trajectory and reasoning overlay plus timestamped model output. This exploratory workflow is approximate and unscored.</p></div><EvaluationLauncher gateway={gateway} host={host} runtime={runtime} onSubmitted={(job) => { setLastSubmitted(job); onOpenJob(job.id); }} onRunLocally={onRunLocally} /></section>
    <section {...stylex.props(s.section4)}><div {...stylex.props(s.stack1)}><h2 {...stylex.props(s.titleMd)}>Runs</h2><p {...stylex.props(s.max3xl, s.textSm, s.leading6, s.textMuted)}>Every run in this workspace, from the web portal and from the desktop app. Runs outlive the tab and the app session; signing out does not cancel them.</p></div><JobHistory gateway={gateway} onOpenJob={onOpenJob} refreshToken={lastSubmitted?.id} /></section>
  </div>;
}
