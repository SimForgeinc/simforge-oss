"use client";

/**
 * The submit path, identical in the browser and on the desktop:
 * upload → validate → choose model → estimate → confirm → submit.
 *
 * Two rules shape it. First, the estimate is a *bound* and is labelled as one:
 * until real cold/warm benchmarks exist the server reports
 * `basis: 'unbenchmarked'` and this screen says so instead of printing a price.
 * Second, the submission carries an idempotency key derived from the prepared
 * inputs, so a lost response or a double click cannot produce a second charged
 * run — the server returns the same job.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SelectMenu } from "../../components/ui/select-menu";
import { Textarea } from "../../components/ui/textarea";
import { RefusalNotice } from "./RefusalNotice";
import { InputPicker, type PreparedInput } from "./InputPicker";
import { ModelPicker, type ModelSelection } from "./ModelPicker";
import type { ComputeEstimate, ComputeJob, ComputeJobKind } from "../contracts";
import type { EvaluationGateway } from "../gateway";
import { ComputeApiError } from "../gateway";
import { MODEL_CATALOG } from "../model-catalog";
import type { ExecutionTarget, HostExecutionSnapshot, ModelRuntimeSnapshot } from "../presentation";
import { formatCentsRange, preferredSelection, submissionIdempotencyKey } from "../presentation";
import { offerableJobKinds } from "../input-kinds";
import {
  availableTextTasks,
  buildOpenLoopParams,
  TEXT_TASK_LABELS,
  type OpenLoopItemKind,
  type TextTask,
  pathShapedRefusal,
} from "../params";

/** Step numbering exists only so the copy can refer to it; the form is one page. */
function StepHeading({ index, title, hint }: { index: number; title: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold text-foreground">
        <span className="mr-2 text-muted-foreground">{index}.</span>
        {title}
      </h2>
      {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export type LocalRunLauncher = (request: {
  selection: ModelSelection;
  prepared: PreparedInput;
  params: Record<string, unknown>;
  kind: ComputeJobKind;
}) => Promise<void>;

export function EvaluationLauncher({
  gateway,
  host,
  runtime,
  onSubmitted,
  /** Desktop only: starts the run on this machine instead of the cloud. */
  onRunLocally,
}: {
  gateway: EvaluationGateway;
  host: HostExecutionSnapshot;
  runtime: ModelRuntimeSnapshot | null;
  onSubmitted: (job: ComputeJob) => void;
  onRunLocally?: LocalRunLauncher;
}) {
  const [selection, setSelection] = useState<ModelSelection>(() =>
    preferredSelection(host, runtime),
  );
  // A derived default must not fight the user: once they choose, the
  // eligibility-derived preference stops applying.
  const [selectionChosen, setSelectionChosen] = useState(false);
  const [prepared, setPrepared] = useState<PreparedInput | null>(null);
  const [kind, setKind] = useState<ComputeJobKind>("alpamayo.openloop");
  const [numTrajSamples, setNumTrajSamples] = useState(4);
  const [navText, setNavText] = useState("");
  const [textTask, setTextTask] = useState<TextTask>("vqa");
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState(1);
  const [scoreWhenAvailable, setScoreWhenAvailable] = useState(true);
  const [estimate, setEstimate] = useState<ComputeEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptNonce, setAttemptNonce] = useState(() => Math.random().toString(36).slice(2, 10));

  // The host's capability report and the model store arrive after first paint,
  // so the derived default is applied again when they land — but never over a
  // choice the user has already made.
  useEffect(() => {
    if (selectionChosen) return;
    setSelection(preferredSelection(host, runtime));
  }, [selectionChosen, host, runtime]);

  const entry = MODEL_CATALOG[selection.family];
  const textTasks = availableTextTasks(entry);

  const offers = useMemo(
    () => (prepared ? offerableJobKinds(prepared.classification, entry) : []),
    [prepared, entry],
  );
  const activeOffer = offers.find((offer) => offer.kind === kind) ?? null;

  const itemKind: OpenLoopItemKind = useMemo(() => {
    const classification = prepared?.classification;
    if (!classification) return "user-clip";
    if (classification.kind === "driving-clip" && classification.probe.schema?.includes("replay-context")) {
      return "replay-context";
    }
    return "user-clip";
  }, [prepared]);

  // Input roles are a closed enum server-side: an open-loop batch is up to 32
  // entries all with role `clip`, and a text run is exactly one `video`. The
  // params items are emitted in the same order as `inputs`, which is what pairs
  // an item with its artifact — a per-item role suffix would be rejected.
  const inputRole = kind === "alpamayo.text" ? "video" : "clip";

  const params = useMemo(() => {
    if (!prepared) return null;
    return buildOpenLoopParams({
      items: prepared.artifacts.map(() => ({
        kind: itemKind,
        role: inputRole,
        cameraProfile: prepared.cameraProfile,
      })),
      reference: scoreWhenAvailable ? "auto" : "none",
      sampling: {
        numTrajSamples,
        ...(entry.capabilities.nav && navText.trim() ? { navText: navText.trim() } : {}),
      },
      task: kind === "alpamayo.text" ? "text" : "act",
      textTask: kind === "alpamayo.text" ? textTask : null,
      prompt: kind === "alpamayo.text" ? prompt.trim() : null,
      seed,
    });
  }, [
    prepared,
    itemKind,
    scoreWhenAvailable,
    numTrajSamples,
    entry.capabilities.nav,
    navText,
    kind,
    inputRole,
    textTask,
    prompt,
    seed,
  ]);

  const submissionInput = useMemo(() => {
    if (!prepared || !params) return null;
    return {
      model: {
        family: selection.family,
        revision: entry.weightsRevision,
        quant: selection.quant,
      },
      inputs: prepared.artifacts.map((artifact) => ({
        role: inputRole,
        artifactId: artifact.artifactId,
      })),
      params,
    };
  }, [prepared, params, selection.family, selection.quant, entry.weightsRevision, inputRole]);

  // Re-estimate whenever the priced shape of the run changes. The estimate is
  // also the affordability/concurrency check, so it must not go stale.
  useEffect(() => {
    if (!submissionInput || selection.target !== "runpod") {
      setEstimate(null);
      return;
    }
    const controller = new AbortController();
    setEstimating(true);
    gateway
      .estimate({ kind, input: submissionInput }, controller.signal)
      .then((result) => setEstimate(result))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setEstimate(null);
        setError(
          cause instanceof ComputeApiError
            ? cause.message
            : "The cost estimate could not be retrieved.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setEstimating(false);
      });
    return () => controller.abort();
  }, [gateway, kind, submissionInput, selection.target]);

  const submit = useCallback(async () => {
    if (!submissionInput || !prepared || !params) return;
    setError(null);
    setSubmitting(true);
    try {
      if (selection.target === "local") {
        if (!onRunLocally) {
          setError("This host cannot start local runs.");
          return;
        }
        await onRunLocally({ selection, prepared, params, kind });
        return;
      }
      const job = await gateway.submitJob({
        kind,
        idempotencyKey: submissionIdempotencyKey({
          kind,
          artifactIds: prepared.artifacts.map((artifact) => artifact.artifactId),
          family: selection.family,
          quant: selection.quant,
          revision: entry.weightsRevision,
          attempt: attemptNonce,
        }),
        input: submissionInput,
      });
      setPrepared(null);
      setEstimate(null);
      setAttemptNonce(Math.random().toString(36).slice(2, 10));
      onSubmitted(job);
    } catch (cause) {
      setError(
        cause instanceof ComputeApiError
          ? cause.message
          : `The job could not be submitted: ${String(cause)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    submissionInput,
    prepared,
    params,
    selection,
    kind,
    gateway,
    entry.weightsRevision,
    attemptNonce,
    onSubmitted,
    onRunLocally,
  ]);

  const blockedReason = activeOffer?.blocked ?? null;
  const textReady = kind !== "alpamayo.text" || prompt.trim().length > 0 || textTask !== "vqa";
  // The control plane refuses any URL- or path-shaped string in params, and a
  // question is free text, so say so here rather than after the upload.
  const paramsRefusal =
    (kind === "alpamayo.text" ? pathShapedRefusal("Your question", prompt) : null) ??
    pathShapedRefusal("The navigation instruction", navText);
  const canSubmit =
    prepared !== null &&
    submissionInput !== null &&
    blockedReason === null &&
    paramsRefusal === null &&
    textReady &&
    !submitting &&
    (selection.target === "local"
      ? onRunLocally !== undefined
      : estimate !== null && estimate.allowed);

  return (
    <div className="space-y-8" data-testid="evaluation-launcher">
      <section className="space-y-3">
        <StepHeading
          index={1}
          title="Input"
          hint="Uploaded straight to storage with a checksum; the server verifies the stored bytes before the artifact can be used."
        />
        <InputPicker
          gateway={gateway}
          model={entry}
          prepared={prepared}
          onPrepared={setPrepared}
          onCleared={() => {
            setPrepared(null);
            setEstimate(null);
          }}
          disabled={submitting}
        />
      </section>

      <section className="space-y-3">
        <StepHeading index={2} title="Model" hint="All three families are listed; where each can run depends on this machine and your workspace." />
        <ModelPicker
          host={host}
          runtime={runtime}
          selection={selection}
          onChange={(next) => {
            setSelectionChosen(true);
            setSelection(next);
          }}
          disabled={submitting}
        />
      </section>

      {prepared ? (
        <section className="space-y-4">
          <StepHeading index={3} title="Run" />

          <fieldset className="space-y-2">
            <legend className="text-xs uppercase tracking-wide text-muted-foreground">Task</legend>
            {offers.map((offer) => (
              <label
                key={offer.kind}
                className="flex cursor-pointer items-start gap-3 border border-border p-3"
              >
                <input
                  type="radio"
                  name="job-kind"
                  className="mt-1"
                  checked={kind === offer.kind}
                  disabled={submitting}
                  onChange={() => setKind(offer.kind)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {offer.kind === "alpamayo.openloop"
                      ? offer.scoreable
                        ? "Open-loop evaluation (scored)"
                        : "Open-loop prediction (not scored)"
                      : "Text analysis"}
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {offer.kind === "alpamayo.openloop"
                      ? "Predicts future ego trajectories. Scored only if the uploaded bundle contains a reference future (future.jsonl)."
                      : "Answers questions about the pixels. Text analysis is not a trajectory evaluation and produces no ADE/FDE."}
                  </span>
                  {offer.blocked ? (
                    <span className="mt-1 block text-xs leading-5 text-amber-600 dark:text-amber-500">
                      {offer.blocked}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>

          {kind === "alpamayo.openloop" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="space-y-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                Trajectory samples
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={numTrajSamples}
                  disabled={submitting}
                  onChange={(event) =>
                    setNumTrajSamples(Math.max(1, Math.min(32, Number(event.target.value) || 1)))
                  }
                />
              </label>
              <label className="space-y-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                Seed
                <Input
                  type="number"
                  min={0}
                  value={seed}
                  disabled={submitting}
                  onChange={(event) => setSeed(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
              {entry.capabilities.nav ? (
                <label className="space-y-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                  Navigation instruction
                  <Input
                    value={navText}
                    placeholder="optional"
                    disabled={submitting}
                    onChange={(event) => setNavText(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="max-w-sm space-y-1.5">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Text task
                </span>
                <SelectMenu
                  label="Text task"
                  value={textTask}
                  disabled={submitting || textTasks.length === 0}
                  options={textTasks.map((task) => ({ value: task, label: TEXT_TASK_LABELS[task] }))}
                  onChange={(value) => setTextTask(value as TextTask)}
                />
              </div>
              {textTask === "vqa" || textTask === "grounding" ? (
                <label className="block space-y-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                  {textTask === "vqa" ? "Question" : "Referring expression"}
                  <Textarea
                    value={prompt}
                    rows={3}
                    disabled={submitting}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
          )}

          {kind === "alpamayo.openloop" ? (
            <label className="flex items-start gap-3 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={scoreWhenAvailable}
                disabled={submitting}
                onChange={(event) => setScoreWhenAvailable(event.target.checked)}
              />
              <span>
                Score against the bundle&apos;s reference future when one is present. Unchecked, the
                run returns a prediction only. No reference is ever derived or synthesized.
              </span>
            </label>
          ) : null}
        </section>
      ) : null}

      {prepared && selection.target === "runpod" ? (
        <section className="space-y-3" data-testid="evaluation-estimate">
          <StepHeading index={4} title="Cost and limits" />
          {estimating ? (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              Estimating…
            </p>
          ) : estimate ? (
            <div className="space-y-3">
              <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Estimated cost
                  </dt>
                  <dd className="text-foreground">
                    {formatCentsRange(estimate.estimate.lowCents, estimate.estimate.highCents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Workspace credit
                  </dt>
                  <dd className="text-foreground">
                    {formatCentsRange(estimate.availableCreditsCents, estimate.availableCreditsCents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Concurrent runs
                  </dt>
                  <dd className="text-foreground">
                    {estimate.concurrency.active} / {estimate.concurrency.limit}
                  </dd>
                </div>
              </dl>
              <p className="text-xs leading-5 text-muted-foreground">
                {estimate.estimate.basis === "unbenchmarked"
                  ? "This is a bound, not a price: no measured cold/warm benchmark exists for this configuration yet. The charge settles from the provider's actual accounting, which includes startup and idle time."
                  : "Bound derived from measured runs. The charge settles from the provider's actual accounting, which includes startup and idle time."}
              </p>
              {estimate.refusal ? (
                <RefusalNotice
                  title="This run cannot be submitted yet"
                  reasons={[estimate.refusal.message]}
                />
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              An estimate appears once an input and model are chosen.
            </p>
          )}
        </section>
      ) : null}

      {paramsRefusal ? (
        <RefusalNotice title="This run cannot be submitted as written" reasons={[paramsRefusal]} />
      ) : null}

      {error ? <RefusalNotice title="Submission failed" reasons={[error]} /> : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button type="button" disabled={!canSubmit} onClick={() => void submit()} data-testid="evaluation-submit">
          {submitting ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Play aria-hidden="true" />
          )}
          {selection.target === "local" ? "Run on this machine" : "Submit cloud run"}
        </Button>
        {prepared ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting || estimating}
            onClick={() => setAttemptNonce(Math.random().toString(36).slice(2, 10))}
          >
            <RefreshCw aria-hidden="true" />
            New submission identity
          </Button>
        ) : null}
        {blockedReason ? (
          <p className="text-xs leading-5 text-amber-600 dark:text-amber-500">{blockedReason}</p>
        ) : null}
      </div>
    </div>
  );
}
