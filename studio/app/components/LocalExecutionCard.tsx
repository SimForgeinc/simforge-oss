"use client";

import { Cpu, LoaderCircle, MonitorCog, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StudioHostCapabilities } from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import { card, local, readyPill, action } from "@/app/components/host-status-cards.stylex";
import { studioHost } from "@/app/lib/host";

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div {...stylex.props(local.row)}>
      <dt {...stylex.props(card.factLabel, local.rowLabel)}>
        {label}
      </dt>
      <dd {...stylex.props(local.rowValue, card.truncate, mono && card.mono)} title={value}>
        {value}
      </dd>
    </div>
  );
}

function ReadyPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span {...stylex.props(readyPill.base, ready ? readyPill.ready : readyPill.notReady)}>
      <span
        aria-hidden="true"
        {...stylex.props(readyPill.dot, ready ? readyPill.dotReady : readyPill.dotNotReady)}
      />
      {label}
    </span>
  );
}

/**
 * Who owns this app's data and what runs on this computer. Everything here is
 * read from the local host's capability probe; nothing is assumed ready.
 *
 * Button variants are StyleX-backed. The caller classes below remain explicit
 * where this card needs a size or presentation override.
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
      {...mergeStyleProps(stylex.props(card.section), className)}
      data-testid="local-execution-card"
      data-local-render-ready={render ? String(render.ready) : nativeWorker ? String(nativeWorker.available) : "unknown"}
    >
      <div {...stylex.props(card.header)}>
        <div {...stylex.props(card.icon)}>
          <Cpu aria-hidden="true" />
        </div>
        <div {...stylex.props(card.body)}>
          <p {...stylex.props(card.eyebrow)}>This computer</p>
          <h2 id="local-execution-title" {...stylex.props(card.title)}>
            {capabilities?.host.label ?? "SimForge Studio"}
            {capabilities?.host.version ? (
              <span {...stylex.props(card.titleVersion)}>v{capabilities.host.version}</span>
            ) : null}
          </h2>
          <p {...stylex.props(card.lede)}>
            Projects, scenarios, jobs and renders live on this computer and run here. A SimCloud account is optional
            and only adds maps and storage.
          </p>

          {error ? (
            <p {...stylex.props(local.error)} role="alert">
              {error}
            </p>
          ) : null}

          {capabilities ? (
            <dl {...stylex.props(local.facts)}>
              <Row label="Owner" value={capabilities.identity.displayName ?? "Local owner"} />
              {capabilities.persistence.kind === "pglite-filesystem" ? (
                <Row label="Data folder" value={capabilities.persistence.dataRoot} mono />
              ) : null}
              <div {...stylex.props(local.row)}>
                <dt {...stylex.props(card.factLabel, local.rowLabel)}>
                  Local render
                </dt>
                <dd {...stylex.props(local.rowValueWrap)}>
                  <ReadyPill
                    ready={render ? render.ready : Boolean(nativeWorker?.available)}
                    label={render ? (render.ready ? "Bevy ready" : "Bevy not ready") : nativeWorker ? (nativeWorker.available ? "Ready" : "Not ready") : "Not offered"}
                  />
                  {!render && nativeWorker?.reason ? <span {...stylex.props(local.rowNote)}>{nativeWorker.reason}</span> : null}
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
                    <div {...stylex.props(local.reasonsRow)}>
                      <ul {...stylex.props(local.reasons)} aria-label="Why local render is not ready">
                        {render.reasons.map((reason) => (
                          <li key={reason} {...stylex.props(local.reason)}>{reason}</li>
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
            <p {...stylex.props(local.probing)}>
              <LoaderCircle className={stylex.props(local.probingSpinner).className} aria-hidden="true" />
              Reading local host capabilities…
            </p>
          ) : null}
        </div>
      </div>

      <div {...stylex.props(card.actions)}>
        <Button
          xstyle={action.outline}
          disabled={refreshing}
          onClick={() => void load(true)}
          type="button"
          variant="outline"
        >
          <RefreshCw {...stylex.props(action.icon, refreshing && action.spin)} aria-hidden="true" />
          Re-check
        </Button>
        <Button asChild xstyle={action.outline} variant="outline">
          <Link href="/dashboard/render-settings">
            <MonitorCog {...stylex.props(action.icon)} aria-hidden="true" />
            Rendering profile &amp; map preparation
          </Link>
        </Button>
      </div>
    </section>
  );
}
