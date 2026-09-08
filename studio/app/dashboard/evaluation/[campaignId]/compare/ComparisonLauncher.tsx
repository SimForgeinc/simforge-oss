"use client";

/**
 * Start a comparison: pick N model configurations, one scenario and seed set,
 * and submit real runs.
 *
 * The compare table answers "what happened". This is the half that lets a
 * person ASK, which is what a model comparison is for. Its rules:
 *
 * - Every column shares the scenario, seeds, step budget, cadence and mode.
 *   They are entered once, above the columns, because a comparison whose
 *   columns differ in them is not a comparison — and making them per-column
 *   would invite exactly that.
 * - Readiness is asked of the server per KIND and per TARGET, not per family. A
 *   cloud worker that serves open-loop inference does not thereby serve the
 *   closed loop, and the launcher says so with the service's own reason rather
 *   than its own guess.
 * - A configuration that cannot run is shown as REFUSED with the reason. It
 *   never becomes a column, and the submit does not silently drop it.
 * - Nothing is faked while runs are pending: submitted columns are reported as
 *   submitted, with their run ids, and the comparison is read from the runs'
 *   own artifacts once they exist.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, X } from "lucide-react";

import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@simforge-oss/studio-ui/components/ui/card";

type ModelVersion = {
  id: string;
  family: string;
  name: string;
  quant: string;
  status: string;
};

type Capabilities = {
  enabled: boolean;
  reason?: string | null;
  families?: {
    family: string;
    available: boolean;
    unavailableReason?: string | null;
    /** Absent means "not reported", which is refused rather than offered. */
    kinds?: string[];
    quants?: string[];
  }[];
};

type ColumnDraft = {
  key: string;
  modelVersionId: string;
  target: "local" | "cloud";
  rigProfile: string;
  quant: string;
};

type LaunchResponse = {
  comparisonId?: string;
  launched?: { label: string; target: string; runIds: string[] }[];
  refused?: { modelVersionId: string; target: string; code: string; reason: string }[];
  error?: string;
  detail?: unknown;
};

const KINDS = [
  { id: "closedloop-episode", label: "Closed loop (episode)", jobKind: "alpamayo.closedloop-episode" },
  { id: "openloop", label: "Open loop (single decision)", jobKind: "alpamayo.openloop" },
] as const;

type Kind = (typeof KINDS)[number]["id"];

/**
 * Why a configuration cannot be submitted, decided from what the server told
 * us — or `null` when it can.
 *
 * This mirrors the server's refusal so a person is not sent to a submit that
 * will fail, but it is NOT the authority: the route re-checks and refuses, and
 * its reason is the one displayed afterwards.
 */
function localRefusal(
  column: ColumnDraft,
  kind: Kind,
  versions: readonly ModelVersion[],
  capabilities: Capabilities | null,
  capabilitiesReason: string | null,
): string | null {
  const version = versions.find((candidate) => candidate.id === column.modelVersionId);
  if (!version) return "Pick a model version.";
  if (column.target === "local") return null;
  if (!capabilities || !capabilities.enabled) {
    return capabilitiesReason ?? capabilities?.reason ?? "No compute service is deployed here.";
  }
  const family = capabilities.families?.find((entry) => entry.family === version.family);
  if (!family || !family.available) {
    return family?.unavailableReason ?? `No compute service is deployed for ${version.family}.`;
  }
  const jobKind = KINDS.find((entry) => entry.id === kind)!.jobKind;
  // Unknown is not ready, same rule as the shared picker: silence about a
  // capability is not permission to offer it.
  if (family.kinds === undefined) {
    return `Required execution capability not reported for ${version.family}.`;
  }
  if (family.kinds.length === 0) {
    return `No cloud service in this deployment runs ${version.family}.`;
  }
  if (!family.kinds.includes(jobKind)) {
    return `The deployed ${version.family} service runs ${family.kinds.join(", ")}, not ${jobKind}.`;
  }
  if (!(family.quants ?? []).includes(column.quant)) {
    return `The deployed ${version.family} service does not serve ${column.quant}.`;
  }
  return null;
}

export function ComparisonLauncher({ campaignId }: { campaignId: string }) {
  const [versions, setVersions] = useState<readonly ModelVersion[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesReason, setCapabilitiesReason] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("closedloop-episode");
  const [spec, setSpec] = useState("");
  const [frameSource, setFrameSource] = useState("");
  const [seedText, setSeedText] = useState("1, 2, 3");
  const [steps, setSteps] = useState(200);
  const [decisionHz, setDecisionHz] = useState(10);
  const [mode, setMode] = useState<"offline-simtime" | "realtime">("offline-simtime");
  const [deadlineMs, setDeadlineMs] = useState(50);
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<LaunchResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/models/versions", { headers: { accept: "application/json" } });
        if (response.ok) {
          const body = (await response.json()) as { versions?: ModelVersion[] };
          if (!cancelled) setVersions(body.versions ?? []);
        }
      } catch {
        // A missing registry is not a launcher error; the columns simply have
        // nothing to pick and the empty state says so.
      }
      try {
        const response = await fetch("/api/simforge/compute/capabilities", {
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          if (!cancelled) setCapabilitiesReason(`Compute unavailable (HTTP ${String(response.status)}).`);
          return;
        }
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as Capabilities;
          if (!cancelled) setCapabilities(parsed);
        } catch {
          if (!cancelled) setCapabilitiesReason("Compute is not deployed in this environment.");
        }
      } catch {
        if (!cancelled) setCapabilitiesReason("Compute is unreachable from here.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const seeds = seedText
    .split(/[,\s]+/)
    .map((piece) => Number.parseInt(piece, 10))
    .filter((value) => Number.isInteger(value) && value >= 0);

  const addColumn = () => {
    const version = versions[columns.length % Math.max(versions.length, 1)];
    setColumns((current) => [
      ...current,
      {
        key: `col-${String(Date.now())}-${String(current.length)}`,
        modelVersionId: version?.id ?? "",
        target: "local",
        rigProfile: "alpamayo-4cam",
        quant: version?.quant ?? "nf4",
      },
    ]);
  };

  const blocking: string[] = [];
  if (columns.length < 2) blocking.push("A comparison needs at least two columns.");
  if (spec.trim().length === 0) blocking.push("Choose the episode spec every column runs.");
  if (seeds.length === 0) blocking.push("Enter at least one seed.");
  if (frameSource.trim().length === 0) {
    blocking.push(
      "Enter a frame source (`dir:<path>` or `bevy:<rig.json>`). Camera views are never synthesized.",
    );
  }
  const refusals = columns.map((column) =>
    localRefusal(column, kind, versions, capabilities, capabilitiesReason),
  );
  const submittable = blocking.length === 0 && refusals.every((refusal) => refusal === null);

  const submit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const response = await fetch("/api/evaluation/comparisons", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          campaignId,
          kind,
          spec: spec.trim(),
          seeds,
          steps,
          decisionHz,
          mode,
          deadlineMs: mode === "realtime" ? deadlineMs : null,
          frameSource: frameSource.trim(),
          columns: columns.map((column) => ({
            modelVersionId: column.modelVersionId,
            target: column.target,
            rigProfile: column.rigProfile,
            quant: column.quant,
          })),
        }),
      });
      setResult((await response.json()) as LaunchResponse);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card data-testid="comparison-launcher">
      <CardHeader>
        <CardTitle className="text-base">Run a new comparison</CardTitle>
        <CardDescription>
          Every column runs the same scenario, seeds and cadence; only the model differs. That is what
          makes a score difference attributable to the model.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Kind</span>
            <select
              className="rounded border bg-transparent px-2 py-1 text-sm"
              value={kind}
              onChange={(event) => setKind(event.target.value as Kind)}
            >
              {KINDS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Mode</span>
            <select
              className="rounded border bg-transparent px-2 py-1 text-sm"
              value={mode}
              onChange={(event) => setMode(event.target.value as "offline-simtime" | "realtime")}
            >
              <option value="offline-simtime">Offline (sim time waits for inference)</option>
              <option value="realtime">Real time (explicit deadline)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">Episode spec</span>
            <input
              className="rounded border bg-transparent px-2 py-1 font-mono text-sm"
              placeholder="packages/evaluation/fixtures/synthetic-leadcar.episodes.json"
              value={spec}
              onChange={(event) => setSpec(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">Frame source</span>
            <input
              className="rounded border bg-transparent px-2 py-1 font-mono text-sm"
              placeholder="dir:/path/to/frames  or  bevy:/path/to/rig.json"
              value={frameSource}
              onChange={(event) => setFrameSource(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Seeds</span>
            <input
              className="rounded border bg-transparent px-2 py-1 font-mono text-sm"
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Steps per episode</span>
            <input
              type="number"
              className="rounded border bg-transparent px-2 py-1 font-mono text-sm"
              value={steps}
              onChange={(event) => setSteps(Number.parseInt(event.target.value, 10) || 0)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Decision rate (Hz)</span>
            <input
              type="number"
              className="rounded border bg-transparent px-2 py-1 font-mono text-sm"
              value={decisionHz}
              onChange={(event) => setDecisionHz(Number.parseInt(event.target.value, 10) || 0)}
            />
          </label>
          {mode === "realtime" ? (
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Deadline (ms)</span>
              <input
                type="number"
                className="rounded border bg-transparent px-2 py-1 font-mono text-sm"
                value={deadlineMs}
                onChange={(event) => setDeadlineMs(Number.parseInt(event.target.value, 10) || 0)}
              />
            </label>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          {columns.map((column, index) => {
            const refusal = refusals[index] ?? null;
            return (
              <div key={column.key} className="flex flex-wrap items-center gap-2 rounded border p-2">
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {index === 0 ? "baseline" : `column ${String(index + 1)}`}
                </Badge>
                <select
                  className="rounded border bg-transparent px-2 py-1 text-sm"
                  value={column.modelVersionId}
                  onChange={(event) =>
                    setColumns((current) =>
                      current.map((candidate, position) =>
                        position === index
                          ? { ...candidate, modelVersionId: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                >
                  <option value="">Pick a model…</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.family} · {version.name} · {version.quant}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded border bg-transparent px-2 py-1 text-sm"
                  value={column.target}
                  onChange={(event) =>
                    setColumns((current) =>
                      current.map((candidate, position) =>
                        position === index
                          ? { ...candidate, target: event.target.value as "local" | "cloud" }
                          : candidate,
                      ),
                    )
                  }
                >
                  <option value="local">This machine</option>
                  <option value="cloud">Cloud</option>
                </select>
                <input
                  className="w-36 rounded border bg-transparent px-2 py-1 font-mono text-xs"
                  value={column.rigProfile}
                  onChange={(event) =>
                    setColumns((current) =>
                      current.map((candidate, position) =>
                        position === index ? { ...candidate, rigProfile: event.target.value } : candidate,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  onClick={() => setColumns((current) => current.filter((_, position) => position !== index))}
                  aria-label="Remove column"
                >
                  <X className="h-4 w-4" />
                </button>
                {refusal !== null ? (
                  <p className="w-full text-xs text-amber-600 dark:text-amber-400">{refusal}</p>
                ) : null}
              </div>
            );
          })}
          <Button variant="outline" size="sm" className="self-start" onClick={addColumn}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add a model column
          </Button>
        </div>

        {blocking.length > 0 ? (
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {blocking.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-3">
          <Button disabled={!submittable || submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Start {String(columns.length)} runs × {String(seeds.length)} seeds
          </Button>
          {result?.comparisonId ? (
            <Link
              className="text-xs hover:underline"
              href={`/dashboard/evaluation/${encodeURIComponent(campaignId)}`}
            >
              Comparison {result.comparisonId} submitted — follow it on the campaign
            </Link>
          ) : null}
        </div>

        {result ? (
          <div className="flex flex-col gap-1 rounded border p-2 text-xs">
            {result.error ? (
              <p className="text-destructive">
                {result.error === "no_column_could_run"
                  ? "No column could run; nothing was submitted."
                  : result.error}
              </p>
            ) : null}
            {(result.launched ?? []).map((column) => (
              <p key={column.label}>
                <span className="font-medium">{column.label}</span> — {String(column.runIds.length)}{" "}
                run(s) queued on {column.target}
              </p>
            ))}
            {(result.refused ?? []).map((refusal) => (
              <p key={`${refusal.modelVersionId}:${refusal.target}`} className="text-amber-600 dark:text-amber-400">
                Refused ({refusal.code}): {refusal.reason}
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
