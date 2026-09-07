"use client";

import { Cpu, LoaderCircle, MonitorCog, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { StudioHostCapabilities } from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { studioHost } from "@/app/lib/host";

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3 py-1.5">
      <dt className="w-32 shrink-0 font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/30 leading-5">
        {label}
      </dt>
      <dd className={cn("min-w-0 truncate text-xs text-white/75", mono && "font-mono")} title={value}>
        {value}
      </dd>
    </div>
  );
}

function ReadyPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-meta text-[8px] font-bold uppercase tracking-[0.13em]",
        ready ? "border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]" : "border-white/10 text-white/45",
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-sm", ready ? "bg-[#E8E044]" : "bg-white/30")} />
      {label}
    </span>
  );
}

/**
 * Who owns this app's data and what runs on this computer. Everything here is
 * read from the local host's capability probe; nothing is assumed ready.
 */
export function LocalExecutionCard({ className }: { className?: string }) {
  const [capabilities, setCapabilities] = useState<StudioHostCapabilities | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (fresh: boolean, signal?: AbortSignal) => {
    setRefreshing(fresh);
    try {
      const next = await studioHost.runtime.capabilities({ fresh, signal });
      if (signal?.aborted) return;
      setCapabilities(next);
      setError("");
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "The local host did not answer.");
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  const render = capabilities?.execution.localRender ?? null;
  const nativeWorker = capabilities?.execution.renderWorkers.native ?? null;
  const runtime = capabilities?.execution.nativeRuntime ?? null;

  return (
    <section
      aria-labelledby="local-execution-title"
      className={cn("text-white", className)}
      data-testid="local-execution-card"
      data-local-render-ready={render ? String(render.ready) : nativeWorker ? String(nativeWorker.available) : "unknown"}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center text-[#E8E044]">
          <Cpu aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">This computer</p>
          <h2 id="local-execution-title" className="mt-1 text-lg font-semibold">
            {capabilities?.host.label ?? "SimForge Studio"}
            {capabilities?.host.version ? (
              <span className="ml-2 font-mono text-xs font-normal text-white/40">v{capabilities.host.version}</span>
            ) : null}
          </h2>
          <p className="mt-2 text-sm leading-6 text-white/55">
            Projects, scenarios, jobs and renders live on this computer and run here. A SimCloud account is optional
            and only adds maps and storage.
          </p>

          {error ? (
            <p className="mt-3 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          {capabilities ? (
            <dl className="mt-3 divide-y divide-white/[0.06]">
              <Row label="Owner" value={capabilities.identity.displayName ?? "Local owner"} />
              {capabilities.persistence.kind === "pglite-filesystem" ? (
                <Row label="Data folder" value={capabilities.persistence.dataRoot} mono />
              ) : null}
              <div className="flex min-w-0 gap-3 py-1.5">
                <dt className="w-32 shrink-0 font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/30 leading-5">
                  Local render
                </dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-white/75">
                  <ReadyPill
                    ready={render ? render.ready : Boolean(nativeWorker?.available)}
                    label={render ? (render.ready ? "Bevy ready" : "Bevy not ready") : nativeWorker ? (nativeWorker.available ? "Ready" : "Not ready") : "Not offered"}
                  />
                  {!render && nativeWorker?.reason ? <span className="text-white/45">{nativeWorker.reason}</span> : null}
                </dd>
              </div>
              {render ? (
                <>
                  <Row
                    label="Render service"
                    value={render.renderService.state === "available" ? render.renderService.path ?? "available" : "missing"}
                    mono
                  />
                  <Row
                    label="Encoder"
                    value={render.encoder.state === "available" ? render.encoder.path ?? "available" : "missing"}
                    mono
                  />
                  <Row
                    label="Actor assets"
                    value={render.actorAssets.state === "available" ? render.actorAssets.path ?? "available" : "missing"}
                    mono
                  />
                  <Row
                    label="Render worker"
                    value={
                      render.worker.attached
                        ? `attached${render.worker.workerId ? ` · ${render.worker.workerId}` : ""}`
                        : "not attached"
                    }
                    mono
                  />
                  <Row label="Runtime folder" value={render.runtimeRoot} mono />
                  {render.reasons.length > 0 ? (
                    <div className="py-1.5">
                      <ul className="list-disc space-y-1 pl-5 text-xs text-amber-300/90" aria-label="Why local render is not ready">
                        {render.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : null}
              <Row
                label="CPU runtime"
                value={
                  runtime?.state === "available"
                    ? `${runtime.runtime.runtimeId} ${runtime.runtime.version} (${runtime.runtime.target})`
                    : runtime?.reason ?? "unknown"
                }
                mono
              />
              <Row
                label="Jobs"
                value={`${capabilities.jobs.families.join(", ")} · ${capabilities.jobs.survivesUiClose ? "keep running when the window closes" : "stop when the window closes"}`}
              />
            </dl>
          ) : !error ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-white/45">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              Reading local host capabilities…
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          className="h-10 gap-2 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5"
          disabled={refreshing}
          onClick={() => void load(true)}
          type="button"
          variant="outline"
        >
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden="true" />
          Re-check
        </Button>
        <Button asChild className="h-10 gap-2 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5" variant="outline">
          <Link href="/dashboard/render-settings">
            <MonitorCog className="size-4" aria-hidden="true" />
            Rendering profile &amp; map preparation
          </Link>
        </Button>
      </div>
    </section>
  );
}
