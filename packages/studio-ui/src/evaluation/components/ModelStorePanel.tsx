"use client";

/**
 * The desktop model manager: download, verify, remove, and see honestly what
 * this machine can execute.
 *
 * All three families and every precision they offer are listed, always. Two
 * separate verdicts are shown per row:
 *
 * - **Download** — do you have the disk and the licence acceptance (and, for
 *   Alpamayo 1.5, a Hugging Face token for its gated sidecar).
 * - **Execution** — can this GPU actually run it, per the runtime's own
 *   measured profile.
 *
 * They are independent. A 16 GB machine may download Alpamayo 2 Super and run
 * it in the cloud; that is a real product path, not an error state, so the row
 * says exactly that instead of hiding the model or claiming it will work.
 */

import { useCallback, useState } from "react";
import {
  CheckCircle2,
  Download,
  HardDriveDownload,
  KeyRound,
  Loader2,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { useVisiblePolling } from "../../lib/use-visible-polling";
import type {
  ModelCatalogEntry,
  ModelExecutionEligibility,
  ModelFamilyId,
  ModelInstallState,
  ModelQuant,
} from "../model-catalog";
import { MODEL_CATALOG, MODEL_FAMILIES } from "../model-catalog";
import { formatBytes, installFraction, installLabel, runtimeKey } from "../presentation";
import type { ModelStoreView } from "../model-store-client";
import { ModelStoreError, modelStore, toRuntimeSnapshot } from "../model-store-client";
import { RefusalNotice } from "./RefusalNotice";

const STATE_POLL_MS = 1000;

function InstallProgress({ state }: { state: ModelInstallState }) {
  const fraction = installFraction(state);
  const detail =
    state.state === "downloading"
      ? `${formatBytes(state.bytesDone)} / ${formatBytes(state.bytesTotal)} · file ${state.filesDone + 1}/${state.filesTotal}${
          state.etaSeconds ? ` · ~${Math.round(state.etaSeconds / 60)} min left` : ""
        }`
      : state.state === "paused"
        ? `${formatBytes(state.bytesDone)} / ${formatBytes(state.bytesTotal)} · resumable`
        : state.state === "verifying"
          ? `verifying digests · ${state.filesDone}/${state.filesTotal}`
          : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          {state.state === "downloading" || state.state === "verifying" ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : null}
          {installLabel(state)}
        </span>
        {detail ? <span className="tabular-nums">{detail}</span> : null}
      </div>
      {fraction !== null ? (
        <div className="h-1.5 w-full bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${fraction * 100}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function QuantRow({
  entry,
  quant,
  install,
  eligibility,
  busy,
  hfTokenPresent,
  onInstall,
  onPause,
  onResume,
  onCancel,
  onVerify,
  onRemove,
}: {
  entry: ModelCatalogEntry;
  quant: ModelQuant;
  install: ModelInstallState | undefined;
  eligibility: ModelExecutionEligibility | undefined;
  busy: boolean;
  hfTokenPresent: boolean;
  onInstall: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onVerify: () => void;
  onRemove: () => void;
}) {
  const offer = entry.quants.find((candidate) => candidate.quant === quant);
  if (!offer) return null;

  const state = install?.state ?? "not_installed";
  const tokenMissing = entry.requiresUserHfToken && !hfTokenPresent;
  const downloadable =
    offer.status !== "unsupported" && (eligibility?.downloadEligible ?? true) && !tokenMissing;

  return (
    <div className="space-y-3 border-t border-border py-4 first:border-t-0" data-testid={`quant-row-${entry.family}-${quant}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-foreground">{quant}</span>
          {offer.status === "supported" ? (
            offer.minVramGiB ? (
              <Badge variant="outline">{offer.minVramGiB} GiB VRAM</Badge>
            ) : null
          ) : (
            <Badge variant="outline">
              {offer.status === "unsupported" ? "Unsupported" : "Unavailable — pending measurement"}
            </Badge>
          )}
          {state === "installed" ? (
            <Badge variant="secondary">
              <CheckCircle2 aria-hidden="true" className="mr-1 size-3" />
              Installed
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {state === "not_installed" || state === "error" ? (
            <Button type="button" size="sm" variant="outline" disabled={busy || !downloadable} onClick={onInstall}>
              {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}
              Download
            </Button>
          ) : null}
          {state === "downloading" ? (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onPause}>
                <Pause aria-hidden="true" />
                Pause
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
                <X aria-hidden="true" />
                Cancel
              </Button>
            </>
          ) : null}
          {state === "paused" ? (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onResume}>
                <Play aria-hidden="true" />
                Resume
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
                <X aria-hidden="true" />
                Discard
              </Button>
            </>
          ) : null}
          {state === "installed" ? (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onVerify}>
                <ShieldCheck aria-hidden="true" />
                Verify
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
                <Trash2 aria-hidden="true" />
                Remove
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">{offer.note}</p>

      {install && install.state !== "not_installed" && install.state !== "installed" ? (
        <InstallProgress state={install} />
      ) : null}

      {install?.state === "installed" ? (
        <p className="text-xs text-muted-foreground">
          {formatBytes(install.bytesOnDisk)} on disk · revision {install.revision.slice(0, 12)}
          {install.digestVerifiedAt
            ? ` · digests verified ${new Date(install.digestVerifiedAt).toLocaleString()}`
            : " · digests not verified yet — run Verify"}
        </p>
      ) : null}
      {install?.state === "error" ? (
        <RefusalNotice
          title={`Install failed during ${install.step}`}
          reasons={[
            install.message,
            install.resumable
              ? "The partial download is kept and can be resumed."
              : "The partial download cannot be resumed; start it again.",
          ]}
        />
      ) : null}

      {tokenMissing ? (
        <RefusalNotice
          tone="warn"
          title="A Hugging Face token is required before any bytes move"
          reasons={[
            `${entry.displayName} depends on a gated sidecar (${entry.sidecars.find((sidecar) => sidecar.requiresUserToken)?.repo}). Accept its terms on Hugging Face, then store your token below.`,
            "Your token is kept in this machine's credential vault. It is never sent to a cloud job, written to an install record, or logged.",
          ]}
        />
      ) : null}

      {eligibility ? (
        <div className="space-y-1 text-xs leading-5">
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Local execution:</span>{" "}
            {eligibility.executionEligible
              ? `available (${eligibility.tier ?? "measured profile"})`
              : `not available on this machine (${eligibility.qualification})`}
          </p>
          {!eligibility.executionEligible && eligibility.reasons.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {eligibility.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {!eligibility.executionEligible && eligibility.downloadEligible ? (
            <p className="text-muted-foreground">
              You can still download it, and you can run this model in the cloud without downloading
              anything.
            </p>
          ) : null}
          {!eligibility.downloadEligible && eligibility.downloadBlockedReasons.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {eligibility.downloadBlockedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ModelStorePanel({ className }: { className?: string }) {
  const [view, setView] = useState<ModelStoreView | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ key: string; ok: boolean; failed: number } | null>(null);
  const [hfToken, setHfToken] = useState("");
  const [generation, setGeneration] = useState(0);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      setView(await modelStore.view(signal));
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(
        cause instanceof ModelStoreError ? cause.message : "The model store could not be read.",
      );
    }
  }, []);

  const anyLive =
    view?.installs.some(
      (entry) => entry.state.state === "downloading" || entry.state.state === "verifying",
    ) ?? false;

  // The light poll: install progress is durable on disk, so polling is
  // restart-safe and needs no stream lifecycle. It stops at terminal states.
  useVisiblePolling(
    async (signal) => {
      if (!view) {
        await reload(signal);
        return;
      }
      if (!anyLive) return;
      try {
        const poll = await modelStore.state(signal);
        if (poll.generation === generation) return;
        setGeneration(poll.generation);
        setView((current) => (current ? { ...current, installs: poll.installs } : current));
      } catch {
        // Keep the last known state; the next tick retries.
      }
    },
    STATE_POLL_MS,
    true,
    `${view === null}:${anyLive}`,
  );

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusyKey(key);
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      if (cause instanceof ModelStoreError && cause.code === "hf_token_required") {
        const detail = cause.detail as { repo?: string; acceptUrl?: string } | undefined;
        setError(
          `A Hugging Face token is required for ${detail?.repo ?? "a gated sidecar"}. Accept its terms${detail?.acceptUrl ? ` at ${detail.acceptUrl}` : ""} and store your token below.`,
        );
      } else {
        setError(cause instanceof ModelStoreError ? cause.message : String(cause));
      }
    } finally {
      setBusyKey(null);
    }
  };

  if (!view) {
    return (
      <div className={cn("space-y-4", className)}>
        {error ? <RefusalNotice title="Model store" reasons={[error]} /> : (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Reading the model store…
          </p>
        )}
      </div>
    );
  }

  const snapshot = toRuntimeSnapshot(view);

  return (
    <div className={cn("space-y-6", className)} data-testid="model-store-panel">
      {error ? <RefusalNotice title="Model store" reasons={[error]} /> : null}
      {(view.reviewGates ?? []).length > 0 ? (
        <RefusalNotice
          tone="warn"
          title="Unresolved obligations on these models"
          reasons={(view.reviewGates ?? []).map(
            (gate) => `${gate.family} — ${gate.kind}: ${gate.note}`,
          )}
        >
          <p className="text-sm leading-6 text-muted-foreground">
            Recorded as unresolved and not markable from here. Downloading and running a model
            locally is unaffected; commercial use is not.
          </p>
        </RefusalNotice>
      ) : null}
      {verify ? (
        <RefusalNotice
          tone={verify.ok ? "info" : "refusal"}
          title={
            verify.ok
              ? "All files match their recorded digests"
              : `${verify.failed} file(s) do not match their recorded digests`
          }
          reasons={
            verify.ok
              ? []
              : ["Remove and download this model again; a mismatched shard cannot be trusted to execute."]
          }
        />
      ) : null}

      <div className="flex flex-wrap items-end gap-3 border border-border p-4">
        <div className="min-w-64 flex-1 space-y-1.5">
          <label
            htmlFor="hf-token"
            className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground"
          >
            <KeyRound aria-hidden="true" className="size-3.5" />
            Hugging Face token
          </label>
          <Input
            id="hf-token"
            type="password"
            autoComplete="off"
            placeholder={
              view.vault.hfTokenPresent
                ? `stored${view.vault.hfTokenIdentity ? ` for ${view.vault.hfTokenIdentity}` : ""}`
                : "hf_…"
            }
            value={hfToken}
            onChange={(event) => setHfToken(event.target.value)}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Needed only for gated sidecars. Kept in{" "}
            {view.vault.persistence === "os-vault"
              ? "this machine's credential vault"
              : "memory for this session only, because no OS vault is available"}
            ; never sent to a cloud job or written to disk in plaintext.
          </p>
        </div>
      </div>

      {MODEL_FAMILIES.map((family) => {
        const entry = view.catalog[family] ?? MODEL_CATALOG[family];
        return (
          <Card key={family} data-testid={`model-card-${family}`}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <HardDriveDownload aria-hidden="true" className="size-4 text-muted-foreground" />
                {entry.displayName}
                {entry.remoteOnly ? <Badge variant="secondary">Cloud execution</Badge> : null}
              </CardTitle>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {entry.weightsRepo} @ {entry.weightsRevision.slice(0, 12)} ·{" "}
                {formatBytes(entry.approxWeightsBytes)} weights, about{" "}
                {formatBytes(entry.approxDiskBytes)} installed ·{" "}
                {entry.cameras.required
                  ? `cameras [${entry.cameras.required.join(", ")}]`
                  : `cameras variable, default [${entry.cameras.default.join(", ")}]`}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {entry.license.id}
                {entry.license.commercialUseReviewRequired
                  ? " · commercial use requires a recorded license review"
                  : ""}
                {entry.license.cardConflictNote ? ` — ${entry.license.cardConflictNote}` : ""}
              </p>
            </CardHeader>
            <CardContent>
              {entry.quants.map((offer) => {
                const key = runtimeKey(family, offer.quant);
                return (
                  <QuantRow
                    key={key}
                    entry={entry}
                    quant={offer.quant}
                    install={snapshot.installs[key]}
                    eligibility={snapshot.eligibility[key]}
                    busy={busyKey === key}
                    hfTokenPresent={view.vault.hfTokenPresent || hfToken.trim().length > 0}
                    onInstall={() =>
                      void act(key, () =>
                        modelStore.install({
                          family,
                          quant: offer.quant,
                          acceptLicense: true,
                          ...(entry.sidecars.some((sidecar) => sidecar.requiresUserToken)
                            ? { acceptSidecarLicense: true as const }
                            : {}),
                          ...(hfToken.trim() ? { hfToken: hfToken.trim() } : {}),
                        }),
                      )
                    }
                    onPause={() => void act(key, () => modelStore.pause(family, offer.quant))}
                    onResume={() => void act(key, () => modelStore.resume(family, offer.quant))}
                    onCancel={() => void act(key, () => modelStore.cancel(family, offer.quant, true))}
                    onVerify={() =>
                      void act(key, async () => {
                        const result = await modelStore.verify(family, offer.quant, true);
                        setVerify({ key, ok: result.ok, failed: result.failed.length });
                      })
                    }
                    onRemove={() =>
                      void act(key, () => modelStore.remove(family, offer.quant, false))
                    }
                  />
                );
              })}
            </CardContent>
          </Card>
        );
      })}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busyKey === "cache"}
          onClick={() =>
            void act("cache", async () => {
              const dry = await modelStore.reclaimCache(true);
              if (dry.reclaimableBytes > 0) await modelStore.reclaimCache(false);
            })
          }
        >
          Reclaim shared download cache
        </Button>
        <p className="text-xs text-muted-foreground">
          Frees cached shards no installed model references. Registry entries with recorded runs are
          retired rather than deleted, so past results keep their provenance.
        </p>
      </div>
    </div>
  );
}
