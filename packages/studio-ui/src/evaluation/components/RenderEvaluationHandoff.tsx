"use client";

/**
 * "Evaluate this render" — the handoff from a finished render to a model run.
 *
 * The point of this panel is that it refuses honestly. A model identifies its
 * cameras by integer slot and rejects an incomplete set, so a render authored
 * with the wrong rig cannot be evaluated no matter how good the imagery is.
 * That verdict is shown BEFORE anything is submitted, naming the slots that are
 * missing and what to do about it, because the alternative is paying for a GPU
 * to tell the user the same thing.
 *
 * It also never claims a chain it does not have: the provenance list is built
 * from ids the control plane returned, and until a run exists there is nothing
 * to show.
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SelectMenuField } from "../../components/ui/select-menu";
import { cn } from "../../lib/utils";
import { MODEL_CATALOG } from "../model-catalog";
import type { ModelFamilyId } from "../model-catalog";
import { RefusalNotice } from "./RefusalNotice";
import {
  ALPAMAYO_CAMERA_SLOT,
  planRenderHandoff,
  runRenderHandoff,
  RenderHandoffRefused,
} from "../render-handoff";
import type {
  RenderEvaluationProvenance,
  RenderHandoffGateway,
  RenderHandoffProgress,
  RenderHandoffSource,
} from "../render-handoff";

export type RenderEvaluationHandoffProps = {
  source: RenderHandoffSource;
  gateway: RenderHandoffGateway;
  /** Families with a reachable executor. Others are listed with their reason. */
  offeredFamilies: readonly {
    family: ModelFamilyId;
    revision: string;
    quant: "bf16" | "nf4" | "fp8";
    available: boolean;
    unavailableReason?: string;
  }[];
  cameraProfile: string;
  onSubmitted?: (jobId: string, provenance: RenderEvaluationProvenance) => void;
  className?: string;
};

const SLOT_NAMES = Object.entries(ALPAMAYO_CAMERA_SLOT)
  .reduce<Record<number, string>>((names, [sensorId, slot]) => ({ ...names, [slot]: sensorId }), {});

export function RenderEvaluationHandoff({
  source,
  gateway,
  offeredFamilies,
  cameraProfile,
  onSubmitted,
  className,
}: RenderEvaluationHandoffProps) {
  const [familyId, setFamilyId] = useState<ModelFamilyId | null>(offeredFamilies[0]?.family ?? null);
  const [progress, setProgress] = useState<RenderHandoffProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<RenderEvaluationProvenance | null>(null);

  const offer = offeredFamilies.find((candidate) => candidate.family === familyId) ?? null;
  const plan = useMemo(
    () => (offer ? planRenderHandoff(source, offer, cameraProfile) : null),
    [source, offer, cameraProfile],
  );

  const submit = useCallback(async () => {
    if (!plan) return;
    setError(null);
    setProgress({ stage: "ingesting", detail: "Starting" });
    try {
      const result = await runRenderHandoff(gateway, plan, {
        // One key per render and model: resubmitting the same pair returns the
        // original run instead of paying twice for the same question.
        idempotencyKey: `render-${plan.source.renderJobId}-${plan.model.family}-${plan.model.quant}`,
        onProgress: setProgress,
      });
      setProvenance(result.provenance);
      onSubmitted?.(result.job.id, result.provenance);
    } catch (cause) {
      setProgress(null);
      setError(
        cause instanceof RenderHandoffRefused
          ? cause.reason
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  }, [gateway, plan, onSubmitted]);

  const renderedSlots = source.cameras
    .map((camera) => ALPAMAYO_CAMERA_SLOT[camera.sensorId])
    .filter((slot): slot is number => slot !== undefined)
    .sort((a, b) => a - b);

  const busy = progress !== null && progress.stage !== "submitted";

  return (
    <section className={cn("space-y-4", className)} data-testid="render-evaluation-handoff">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">Evaluate this render</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          The rendered cameras become the clip a model reads. The trajectory the simulation executed
          becomes the reference it is scored against — simulation truth, not recorded ground truth,
          and the result says so.
        </p>
      </header>

      <dl className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="uppercase tracking-wide text-muted-foreground">Rendered cameras</dt>
          <dd className="mt-1 font-mono text-foreground">
            {renderedSlots.length > 0
              ? renderedSlots.map((slot) => `${slot} · ${SLOT_NAMES[slot] ?? "unknown"}`).join("  ")
              : "none that map to a model camera slot"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="uppercase tracking-wide text-muted-foreground">Render job</dt>
          <dd className="mt-1 truncate font-mono text-foreground">{source.renderJobId}</dd>
        </div>
      </dl>

      <SelectMenuField
        label="Model"
        value={familyId ?? ""}
        options={offeredFamilies.map((candidate) => {
          const entry = MODEL_CATALOG[candidate.family];
          return {
            value: candidate.family,
            label: `${entry?.displayName ?? candidate.family} · ${candidate.quant}${
              candidate.available ? "" : " — unavailable"
            }`,
            disabled: !candidate.available,
          };
        })}
        onChange={(value) => {
          setFamilyId(value as ModelFamilyId);
          setError(null);
          setProvenance(null);
        }}
      />

      {offer && !offer.available ? (
        <RefusalNotice
          tone="warn"
          title="No executor for this model here"
          reasons={[offer.unavailableReason ?? "This deployment has no service for this model."]}
        />
      ) : null}

      {plan && !plan.check.compatible ? (
        <RefusalNotice title="This render cannot be evaluated by that model" reasons={[plan.check.reason]} />
      ) : null}

      {plan && plan.check.compatible ? (
        <p className="text-xs leading-5 text-muted-foreground" data-testid="handoff-ready">
          Camera slots {plan.check.slots.join(", ")} satisfy this model. The clip bundle is built by
          the control plane from this render's own manifest, trace and camera videos — the frames and
          poses come from the render, and any instant without a real sample is refused rather than
          interpolated.
        </p>
      ) : null}

      {error ? <RefusalNotice title="Handoff failed" reasons={[error]} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={!plan?.check.compatible || !offer?.available || busy}
          onClick={() => void submit()}
          data-testid="render-evaluation-submit"
        >
          {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
          Evaluate this render
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
        {progress ? (
          <span className="text-xs text-muted-foreground" data-testid="handoff-progress">
            {progress.detail}
          </span>
        ) : null}
      </div>

      {provenance ? (
        <section className="space-y-2 border-border border-t pt-3" data-testid="handoff-provenance">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Chain of custody
          </h3>
          <ol className="space-y-1.5 text-xs">
            {[
              ["Scenario", `${provenance.scenarioDocumentId} · ${provenance.scenarioContentSha256.slice(0, 16)}`],
              ["Render job", provenance.renderJobId],
              ["Rig", provenance.rigPresetId ?? "authored rig"],
              [
                "Capture identity",
                provenance.captureVersion
                  ?? "not supplied by the producer — the rig name is not an identity",
              ],
              [
                "Camera slots",
                provenance.renderedNotConsumed.length > 0
                  ? `${provenance.cameraSlots.join(", ")} consumed · ${provenance.renderedNotConsumed.join(", ")} rendered but not consumed`
                  : provenance.cameraSlots.join(", "),
              ],
              ["Render manifest", provenance.renderManifestArtifactId],
              ["Behaviour trace", provenance.traceArtifactId],
              ["Camera videos", provenance.cameraVideoArtifactIds.join(", ")],
              ["Clip bundle", provenance.clipBundleArtifactId],
              ["Reference", `${provenance.referenceKind}${provenance.referenceKind === "authored" ? " — simulation truth" : ""}`],
              [
                "Frame cadence",
                provenance.timeBase
                  ? `${provenance.timeBase.renderFps} fps rendered → ${provenance.timeBase.modelHz} Hz consumed · ${
                    provenance.timeBase.cadenceDividesExactly
                      ? "divides exactly, no resampling"
                      : `nearest-frame, worst error ${(provenance.timeBase.worstResampleErrorS * 1000).toFixed(1)} ms`
                  }`
                  : "not reported by the converter",
              ],
              ["Model", `${provenance.model.family} @ ${provenance.model.revision.slice(0, 12)} · ${provenance.model.quant}`],
              ["Evaluation run", provenance.computeJobId],
            ].map(([label, value]) => (
              <li key={label} className="flex min-w-0 gap-3">
                <span className="w-32 shrink-0 uppercase tracking-wide text-muted-foreground">{label}</span>
                <span className="min-w-0 truncate font-mono text-foreground">{value}</span>
              </li>
            ))}
          </ol>
          <Badge variant="outline">Every link is a stored field, not a reconstruction</Badge>
        </section>
      ) : null}
    </section>
  );
}
