"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { Input } from "../../components/ui/input";
import { SelectMenu } from "../../components/ui/select-menu";
import { Button } from "../../components/ui/button";
import { styles as s } from "./evaluation-components.stylex";
import { InputPicker, type PreparedInput } from "./InputPicker";
import { ModelPicker, type ModelSelection } from "./ModelPicker";
import { RefusalNotice } from "./RefusalNotice";
import type {
  ComputeEstimate,
  ComputeJob,
  ComputeJobKind,
  ComputeJobModelRef,
  ComputeJobSubmission,
} from "../contracts";
import type { EvaluationGateway } from "../gateway";
import { ComputeApiError } from "../gateway";
import { MODEL_CATALOG, type ModelFamilyId } from "../model-catalog";
import {
  buildOpenLoopParams,
  remapUploadedCamera,
  type UploadedVideoCamera,
} from "../params";
import type { HostExecutionSnapshot, ModelRuntimeSnapshot } from "../presentation";
import { formatCentsRange, submissionIdempotencyKey } from "../presentation";

const VIDEO_MODEL_FAMILIES = ["alpamayo-1.5", "alpamayo-2-super"] as const satisfies readonly ModelFamilyId[];
const CAMERA_OPTIONS = [
  { value: "0", label: "0 · Cross-left wide (120°)" },
  { value: "1", label: "1 · Front-wide (120°)" },
  { value: "2", label: "2 · Cross-right wide (120°)" },
  { value: "3", label: "3 · Rear-left (70°)" },
  { value: "4", label: "4 · Rear tele (30°)" },
  { value: "5", label: "5 · Rear-right (70°)" },
  { value: "6", label: "6 · Front tele (30°)" },
] as const;
const MULTI_CAMERA_DEFAULT_ORDER = [0, 1, 2, 3, 5, 6, 4] as const;

function defaultSelection(): ModelSelection {
  return { family: "alpamayo-1.5", quant: "bf16", target: "runpod" };
}

function defaultCameraMappings(count: number): UploadedVideoCamera[] {
  const ids = count === 1 ? [1] : MULTI_CAMERA_DEFAULT_ORDER.slice(0, count);
  return ids.map((cameraId, inputIndex) => ({ cameraId, inputIndex, offsetSeconds: 0 }));
}

function StepHeading({ index, title, hint }: { index: number; title: string; hint?: string }) {
  return (
    <div {...stylex.props(s.stack1)}>
      <h2 {...stylex.props(s.titleSm)}><span {...stylex.props(s.mr2, s.textMuted)}>{index}.</span> {title}</h2>
      {hint ? <p {...stylex.props(s.textXs, s.leading5, s.textMuted)}>{hint}</p> : null}
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
  onRunLocally,
}: {
  gateway: EvaluationGateway;
  host: HostExecutionSnapshot;
  runtime: ModelRuntimeSnapshot | null;
  onSubmitted: (job: ComputeJob) => void;
  onRunLocally?: LocalRunLauncher;
}) {
  const [selection, setSelection] = useState<ModelSelection>(defaultSelection);
  const [prepared, setPrepared] = useState<PreparedInput | null>(null);
  const [cameras, setCameras] = useState<UploadedVideoCamera[]>([]);
  const [primaryCameraId, setPrimaryCameraId] = useState(1);
  const [horizontalFovDeg, setHorizontalFovDeg] = useState(90);
  const [cameraHeightM, setCameraHeightM] = useState(1.5);
  const [egoSpeedMps, setEgoSpeedMps] = useState(0);
  const [predictionHz, setPredictionHz] = useState(1);
  const [seed, setSeed] = useState(1);
  const [estimate, setEstimate] = useState<ComputeEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptNonce, setAttemptNonce] = useState(() => Math.random().toString(36).slice(2, 10));


  const entry = MODEL_CATALOG[selection.family];
  const kind: ComputeJobKind = "alpamayo.openloop";

  const acceptPrepared = useCallback((next: PreparedInput) => {
    const mappings = defaultCameraMappings(next.files.length);
    setPrepared(next);
    setCameras(mappings);
    setPrimaryCameraId(mappings.find((camera) => camera.cameraId === 1)?.cameraId ?? mappings[0]?.cameraId ?? 1);
    setEstimate(null);
  }, []);

  const clearPrepared = useCallback(() => {
    setPrepared(null);
    setCameras([]);
    setEstimate(null);
  }, []);

  const params = useMemo(() => {
    if (!prepared || cameras.length !== prepared.files.length) return null;
    return buildOpenLoopParams({
      items: prepared.files.map(() => ({
        kind: "user-clip",
        role: "video",
        cameraProfile: "uploaded-video",
      })),
      reference: "none",
      sampling: { numTrajSamples: 4 },
      task: "act",
      seed,
      ood: {
        exploratory: true,
        assumedStationaryEgo: egoSpeedMps === 0,
        assumedIntrinsics: {
          model: "pinhole",
          horizontalFovDeg,
          cameraHeightM,
        },
      },
      video: {
        cameras: cameras.map((camera) =>
          camera.cameraId === primaryCameraId ? { ...camera, offsetSeconds: 0 } : camera,
        ),
        primaryCameraId,
        horizontalFovDeg,
        cameraHeightM,
        egoSpeedMps,
        predictionHz,
      },
    });
  }, [prepared, cameras, seed, egoSpeedMps, primaryCameraId, horizontalFovDeg, cameraHeightM, predictionHz]);

  const submissionInput = useMemo<ComputeJobSubmission["input"] | null>(() => {
    if (!prepared || !params || prepared.artifacts.length !== prepared.files.length) return null;
    const model: ComputeJobModelRef = {
      family: selection.family,
      revision: entry.weightsRevision,
      quant: selection.quant,
    };
    return {
      model,
      inputs: prepared.artifacts.map((artifact) => ({ role: "video" as const, artifactId: artifact.artifactId })),
      params,
    };
  }, [prepared, params, selection.family, selection.quant, entry.weightsRevision]);

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
          cause instanceof ComputeApiError ? cause.message : "The cost estimate could not be retrieved.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setEstimating(false);
      });
    return () => controller.abort();
  }, [gateway, kind, submissionInput, selection.target]);

  const submit = useCallback(async () => {
    if (!prepared || !params) return;
    setError(null);
    setSubmitting(true);
    try {
      if (selection.target === "local") {
        if (!onRunLocally) throw new Error("This host cannot start local runs.");
        await onRunLocally({ selection, prepared, params, kind });
        return;
      }
      if (!submissionInput) return;
      const job = await gateway.submitJob({
        kind,
        idempotencyKey: await submissionIdempotencyKey({
          kind,
          artifactIds: prepared.artifacts.map((artifact) => artifact.artifactId),
          family: selection.family,
          quant: selection.quant,
          revision: entry.weightsRevision,
          attempt: attemptNonce,
        }),
        input: submissionInput,
      });
      clearPrepared();
      setAttemptNonce(Math.random().toString(36).slice(2, 10));
      onSubmitted(job);
    } catch (cause) {
      setError(
        cause instanceof ComputeApiError
          ? cause.message
          : `The job could not be submitted: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }, [prepared, params, selection, onRunLocally, submissionInput, gateway, entry.weightsRevision, attemptNonce, clearPrepared, onSubmitted]);

  const selectedIds = new Set(cameras.map((camera) => camera.cameraId));
  const localUnavailable =
    selection.target === "local" && onRunLocally === undefined
      ? "This host cannot start local runs. Choose cloud execution, or run this from the desktop app."
      : null;
  const canSubmit =
    prepared !== null &&
    params !== null &&
    cameras.length > 0 &&
    selectedIds.size === cameras.length &&
    localUnavailable === null &&
    !submitting &&
    (selection.target === "local" ? onRunLocally !== undefined : submissionInput !== null && estimate !== null && estimate.allowed);

  const updateCameraId = (inputIndex: number, nextId: number) => {
    const next = remapUploadedCamera(cameras, primaryCameraId, inputIndex, nextId);
    setCameras(next.cameras);
    setPrimaryCameraId(next.primaryCameraId);
  };

  return (
    <div {...stylex.props(s.section8)} data-testid="evaluation-launcher">
      <section {...stylex.props(s.section3)}>
        <StepHeading
          index={1}
          title="Camera videos"
          hint="Choose one ordinary video or all synchronized camera recordings together. Their overlapping usable interval must contain at least 0.4 seconds of real footage and may be at most 60 seconds."
        />
        <InputPicker
          gateway={gateway}
          model={entry}
          prepared={prepared}
          onPrepared={acceptPrepared}
          onCleared={clearPrepared}
          disabled={submitting}
          execution={selection.target}
        />
      </section>

      <section {...stylex.props(s.section3)}>
        <StepHeading
          index={2}
          title="Model"
        />
        <ModelPicker
          host={host}
          runtime={runtime}
          selection={selection}
          onChange={setSelection}
          disabled={submitting}
          families={VIDEO_MODEL_FAMILIES}
          uploadedVideo
          cloudOnly
        />
      </section>

      {prepared ? (
        <section {...stylex.props(s.section4)} data-testid="video-camera-mapping">
          <StepHeading
            index={3}
            title="Map cameras and timing"
            hint="Identify the physical view in each file. Input order remains exactly as uploaded; this mapping tells the model which real camera each input contains."
          />
          <div {...stylex.props(s.borderBox)}>
            {prepared.files.map((file, inputIndex) => {
              const camera = cameras.find((entry) => entry.inputIndex === inputIndex);
              if (!camera) return null;
              return (
                <div key={`${file.name}-${inputIndex}`} {...stylex.props(s.cameraGrid)}>
                  <div {...stylex.props(s.min0)}>
                    <p {...stylex.props(s.truncate, s.textSm, s.fontMedium, s.textFg)}>{file.name}</p>
                    <label {...stylex.props(s.mt2, s.flexGap2, s.textXs, s.textMuted)}>
                      <input
                        type="radio"
                        name="primary-camera"
                        checked={primaryCameraId === camera.cameraId}
                        disabled={submitting}
                        onChange={() => {
                          setPrimaryCameraId(camera.cameraId);
                          setCameras((current) =>
                            current.map((entry) =>
                              entry.inputIndex === inputIndex
                                ? { ...entry, offsetSeconds: 0 }
                                : entry,
                            ),
                          );
                        }}
                      />
                      Primary view for the overlay
                    </label>
                  </div>
                  <div {...stylex.props(s.labelStack)}>
                    <span {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Camera position</span>
                    <SelectMenu
                      label={`Camera position for ${file.name}`}
                      value={String(camera.cameraId)}
                      disabled={submitting}
                      options={CAMERA_OPTIONS}
                      onChange={(value) => updateCameraId(inputIndex, Number(value))}
                    />
                  </div>
                  <label {...stylex.props(s.labelStack, s.textXs, s.uppercaseWide, s.textMuted)}>
                    Offset (seconds)
                    <Input
                      type="number"
                      step={0.01}
                      value={camera.offsetSeconds}
                      disabled={submitting || primaryCameraId === camera.cameraId}
                      aria-label={`Temporal offset for ${file.name} in seconds`}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setCameras((current) =>
                          current.map((entry) =>
                            entry.inputIndex === inputIndex
                              ? { ...entry, offsetSeconds: Number.isFinite(value) ? value : 0 }
                              : entry,
                          ),
                        );
                      }}
                    />
                  </label>
                </div>
              );
            })}
          </div>
          <p {...stylex.props(s.textXs, s.leading5, s.textMuted)}>
            The primary camera defines time zero, so its offset is fixed at 0. For every other
            camera, a positive offset means its recording starts later than the primary timeline;
            use a negative value when it starts earlier. No missing camera view is duplicated or
            invented.
          </p>

          <details {...stylex.props(s.border, s.mutedSurface10)}>
            <summary {...stylex.props(s.cursor, s.px4py3, s.textSm, s.fontMedium, s.textFg)}>
              Advanced assumptions
            </summary>
            <div {...stylex.props(s.space4, s.borderTop, s.p4)}>
              <p {...stylex.props(s.max3xl, s.textSm, s.leading6, s.textMuted)}>
                Ordinary video does not include measured camera calibration or vehicle motion. The
                overlay therefore uses an approximate pinhole camera and a constant-speed,
                straight-ahead ego history. Edit these values when you know them. The result is an
                approximate, exploratory prediction and is never scored against ground truth.
              </p>
              <div {...stylex.props(s.grid2)}>
                <label {...stylex.props(s.labelStack, s.textXs, s.uppercaseWide, s.textMuted)}>
                  Horizontal FOV (degrees)
                  <Input type="number" min={20} max={170} step={1} value={horizontalFovDeg} disabled={submitting} onChange={(event) => setHorizontalFovDeg(Math.max(20, Math.min(170, Number(event.target.value) || 20)))} />
                </label>
                <label {...stylex.props(s.labelStack, s.textXs, s.uppercaseWide, s.textMuted)}>
                  Camera height (m)
                  <Input type="number" min={0.1} max={10} step={0.1} value={cameraHeightM} disabled={submitting} onChange={(event) => setCameraHeightM(Math.max(0.1, Math.min(10, Number(event.target.value) || 0.1)))} />
                </label>
                <label {...stylex.props(s.labelStack, s.textXs, s.uppercaseWide, s.textMuted)}>
                  Ego speed (m/s)
                  <Input type="number" min={0} max={80} step={0.1} value={egoSpeedMps} disabled={submitting} onChange={(event) => setEgoSpeedMps(Math.max(0, Math.min(80, Number(event.target.value) || 0)))} />
                </label>
                <label {...stylex.props(s.labelStack, s.textXs, s.uppercaseWide, s.textMuted)}>
                  Predictions / second
                  <Input type="number" min={0.1} max={2} step={0.1} value={predictionHz} disabled={submitting} onChange={(event) => setPredictionHz(Math.max(0.1, Math.min(2, Number(event.target.value) || 0.1)))} />
                </label>
                <label {...stylex.props(s.labelStack, s.textXs, s.uppercaseWide, s.textMuted)}>
                  Seed
                  <Input type="number" min={0} step={1} value={seed} disabled={submitting} onChange={(event) => setSeed(Math.max(0, Math.floor(Number(event.target.value) || 0)))} />
                </label>
              </div>
            </div>
          </details>
        </section>
      ) : null}

      {prepared && selection.target === "runpod" ? (
        <section {...stylex.props(s.space3)} data-testid="evaluation-estimate">
          <StepHeading index={4} title="Cost and limits" />
          {estimating ? (
            <p {...stylex.props(s.inlineGap2, s.textSm, s.textMuted)}>
              <Loader2 aria-hidden="true" {...stylex.props(s.iconPlain, s.spinner)} />
              Estimating…
            </p>
          ) : estimate ? (
            <div {...stylex.props(s.space3)}><dl {...stylex.props(s.grid3, s.textSm)}>
              <div>
                <dt {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Estimated cost</dt>
                <dd {...stylex.props(s.textFg)}>{formatCentsRange(estimate.estimate.lowCents, estimate.estimate.highCents)}</dd>
              </div>
              <div>
                <dt {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Workspace credit</dt>
                <dd {...stylex.props(s.textFg)}>{formatCentsRange(estimate.availableCreditsCents, estimate.availableCreditsCents)}</dd>
              </div>
              <div>
                <dt {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Concurrent runs</dt>
                <dd {...stylex.props(s.textFg)}>{estimate.concurrency.active} / {estimate.concurrency.limit}</dd>
              </div>
            </dl>
            <p {...stylex.props(s.textXs, s.leading5, s.textMuted)}>
              This is a cost bound. Settlement uses the provider&apos;s actual accounting, including startup and idle time.
            </p>
            {estimate.refusal ? <RefusalNotice title="This run cannot be submitted yet" reasons={[estimate.refusal.message]} /> : null}</div>
          ) : (
            <p {...stylex.props(s.textSm, s.textMuted)}>An estimate appears once the videos are uploaded and mapped.</p>
          )}
        </section>
      ) : null}

      {localUnavailable ? <RefusalNotice title="Local execution is not available here" reasons={[localUnavailable]} /> : null}
      {error ? <RefusalNotice title="Submission failed" reasons={[error]} /> : null}

      <div {...stylex.props(s.row, s.borderTop, s.pt5)}>
        <Button type="button" disabled={!canSubmit} onClick={() => void submit()} data-testid="evaluation-submit">
          {submitting ? <Loader2 aria-hidden="true" {...stylex.props(s.spinner)} /> : <Play aria-hidden="true" />}
          {selection.target === "local" ? "Run prediction on this machine" : "Submit prediction"}
        </Button>
        {prepared ? (
          <Button type="button" variant="ghost" size="sm" disabled={submitting || estimating} onClick={() => setAttemptNonce(Math.random().toString(36).slice(2, 10))}>
            <RefreshCw aria-hidden="true" />
            New submission identity
          </Button>
        ) : null}
      </div>
    </div>
  );
}
