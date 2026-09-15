"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ComparisonLauncher.stylex";
/**
 * Start a comparison: pick N model configurations, one scenario and seed set,
 * and submit real runs.
 *
 * The compare table answers "what happened". This is the half that lets a
 * person ASK, which is what a model comparison is for. Its rules:
 *
 * - Every column shares the scenario, seeds, step budget, cadence and mode.
 * They are entered once, above the columns, because a comparison whose
 * columns differ in them is not a comparison — and making them per-column
 * would invite exactly that.
 * - Readiness is asked of the server per KIND and per TARGET, not per family. A
 * cloud worker that serves open-loop inference does not thereby serve the
 * closed loop, and the launcher says so with the service's own reason rather
 * than its own guess.
 * - A configuration that cannot run is shown as REFUSED with the reason. It
 * never becomes a column, and the submit does not silently drop it.
 * - Nothing is faked while runs are pending: submitted columns are reported as
 * submitted, with their run ids, and the comparison is read from the runs'
 * own artifacts once they exist.
 */

import { useEffect, useState } from "react";
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

type LocalVerdict = {
  install: { state: string; digestVerifiedAt?: string | null };
  eligibility: { executionEligible: boolean; reasons: string[] } | null;
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
  local: Record<string, LocalVerdict> | null,
): string | null {
  const version = versions.find((candidate) => candidate.id === column.modelVersionId);
  if (!version) return "Pick a model version.";
  if (column.target === "local") {
    if (local === null) return null; // still asking; not a claim either way
    const verdict = local[version.family];
    if (!verdict) return `Local readiness for ${version.family} was not reported here.`;
    if (verdict.install.state !== "installed") {
      return `The weights for ${version.family} are ${verdict.install.state.replace("_", " ")} on this machine.`;
    }
    if (!verdict.install.digestVerifiedAt) {
      return `The ${version.family} install has not been digest-verified.`;
    }
    if (!verdict.eligibility || !verdict.eligibility.executionEligible) {
      return verdict.eligibility?.reasons.join(" ") ?? `No execution verdict for ${version.family} here.`;
    }
    return null;
  }
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

export function ComparisonLauncher({
  campaignId,
  onSelectCampaign,
}: {
  campaignId: string;
  /** Follow the submitted comparison on its campaign, in place. */
  onSelectCampaign: (campaignId: string) => void;
}) {
  const [versions, setVersions] = useState<readonly ModelVersion[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesReason, setCapabilitiesReason] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, LocalVerdict> | null>(null);
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
        // `/api/simforge/compute/**` is SimCloud's control plane, on the
        // Cloud's origin. The renderer holds no cloud credentials, so the
        // browser asks this host's authenticated proxy, which forwards to
        // the same route under the same contract.
        const response = await fetch("/api/simforge/cloud/compute/capabilities", {
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

  // The desktop model store's own verdicts, asked for the KIND selected: closed
  // loop reserves the native renderer, and whether a model fits alone is a
  // different question from whether it fits with the renderer resident. Refetched
  // when the kind changes, because the answer changes with it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const reserve = kind === "closedloop-episode" ? "?reserveRenderer=1" : "";
        const [storeResponse, preflightResponse] = await Promise.all([
          fetch("/api/models/store", { headers: { accept: "application/json" } }),
          fetch(`/api/models/store/preflight${reserve}`, { headers: { accept: "application/json" } }),
        ]);
        if (!storeResponse.ok || !preflightResponse.ok) {
          // Desktop-only routes. In the browser portal there is no local store,
          // and the local target is refused with that reason rather than offered.
          if (!cancelled) setLocal({});
          return;
        }
        const store = (await storeResponse.json()) as {
          installs?: { family: string; state: { state: string; digestVerifiedAt?: string | null } }[];
        };
        const report = (await preflightResponse.json()) as {
          eligibility?: { family: string; executionEligible: boolean; reasons: string[] }[];
        };
        const merged: Record<string, LocalVerdict> = {};
        for (const entry of report.eligibility ?? []) {
          if (merged[entry.family]) continue;
          merged[entry.family] = {
            install:
              store.installs?.find((install) => install.family === entry.family)?.state ?? {
                state: "not_installed",
              },
            eligibility: { executionEligible: entry.executionEligible, reasons: entry.reasons },
          };
        }
        if (!cancelled) setLocal(merged);
      } catch {
        if (!cancelled) setLocal({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind]);

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
    localRefusal(column, kind, versions, capabilities, capabilitiesReason, local),
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
        <CardTitle xstyle={styles.runANewComparisonCardTitle}>Run a new comparison</CardTitle>
        <CardDescription>
          Every column runs the same scenario, seeds and cadence; only the model differs. That is what
          makes a score difference attributable to the model.
        </CardDescription>
      </CardHeader>
      <CardContent xstyle={styles.cardcontentFlex}>
        <div {...stylex.props(styles.divGrid)}>
          <label {...stylex.props(styles.labelFlexXs)}>
            <span {...stylex.props(styles.kind)}>Kind</span>
            <select
              {...stylex.props(styles.selectSm)}
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
          <label {...stylex.props(styles.labelFlexXs2)}>
            <span {...stylex.props(styles.mode)}>Mode</span>
            <select
              {...stylex.props(styles.selectSm2)}
              value={mode}
              onChange={(event) => setMode(event.target.value as "offline-simtime" | "realtime")}
            >
              <option value="offline-simtime">Offline (sim time waits for inference)</option>
              <option value="realtime">Real time (explicit deadline)</option>
            </select>
          </label>
          <label {...stylex.props(styles.labelFlexXs3)}>
            <span {...stylex.props(styles.episodeSpec)}>Episode spec</span>
            <input
              {...stylex.props(styles.inputMonoSm)}
              placeholder="packages/evaluation/fixtures/synthetic-leadcar.episodes.json"
              value={spec}
              onChange={(event) => setSpec(event.target.value)}
            />
          </label>
          <label {...stylex.props(styles.labelFlexXs4)}>
            <span {...stylex.props(styles.frameSource)}>Frame source</span>
            <input
              {...stylex.props(styles.inputMonoSm2)}
              placeholder="dir:/path/to/frames or bevy:/path/to/rig.json"
              value={frameSource}
              onChange={(event) => setFrameSource(event.target.value)}
            />
          </label>
          <label {...stylex.props(styles.labelFlexXs5)}>
            <span {...stylex.props(styles.seeds)}>Seeds</span>
            <input
              {...stylex.props(styles.inputMonoSm3)}
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
            />
          </label>
          <label {...stylex.props(styles.labelFlexXs6)}>
            <span {...stylex.props(styles.stepsPerEpisode)}>Steps per episode</span>
            <input
              type="number"
              {...stylex.props(styles.inputMonoSm4)}
              value={steps}
              onChange={(event) => setSteps(Number.parseInt(event.target.value, 10) || 0)}
            />
          </label>
          <label {...stylex.props(styles.labelFlexXs7)}>
            <span {...stylex.props(styles.decisionRate)}>Decision rate (Hz)</span>
            <input
              type="number"
              {...stylex.props(styles.inputMonoSm5)}
              value={decisionHz}
              onChange={(event) => setDecisionHz(Number.parseInt(event.target.value, 10) || 0)}
            />
          </label>
          {mode === "realtime" ? (
            <label {...stylex.props(styles.labelFlexXs8)}>
              <span {...stylex.props(styles.deadline)}>Deadline (ms)</span>
              <input
                type="number"
                {...stylex.props(styles.inputMonoSm6)}
                value={deadlineMs}
                onChange={(event) => setDeadlineMs(Number.parseInt(event.target.value, 10) || 0)}
              />
            </label>
          ) : null}
        </div>

        <div {...stylex.props(styles.divFlex)}>
          {columns.map((column, index) => {
            const refusal = refusals[index] ?? null;
            return (
              <div key={column.key} {...stylex.props(styles.divFlex2)}>
                <Badge variant="secondary" xstyle={styles.badgeMono}>
                  {index === 0 ? "baseline" : `column ${String(index + 1)}`}
                </Badge>
                <select
                  {...stylex.props(styles.selectSm3)}
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
                  {...stylex.props(styles.selectSm4)}
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
                  {...stylex.props(styles.inputMonoXs)}
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
                  {...stylex.props(styles.removeColumnButton)}
                  onClick={() => setColumns((current) => current.filter((_, position) => position !== index))}
                  aria-label="Remove column"
                >
                  <X {...stylex.props(styles.x)} />
                </button>
                {refusal !== null ? (
                  <p {...stylex.props(styles.pXs)}>{refusal}</p>
                ) : null}
              </div>
            );
          })}
          <Button variant="outline" size="sm" xstyle={styles.button} onClick={addColumn}>
            <Plus {...stylex.props(styles.addAModelColumnPlus)} />
            Add a model column
          </Button>
        </div>

        {blocking.length > 0 ? (
          <ul {...stylex.props(styles.ulXs)}>
            {blocking.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}

        <div {...stylex.props(styles.divFlex3)}>
          <Button disabled={!submittable || submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 {...stylex.props(styles.loader2)} /> : null}
            Start {String(columns.length)} runs × {String(seeds.length)} seeds
          </Button>
          {result?.comparisonId ? (
            <button
              type="button"
              {...stylex.props(styles.comparisonLink)}
              onClick={() => onSelectCampaign(campaignId)}
            >
              Comparison {result.comparisonId} submitted — follow it on the campaign
            </button>
          ) : null}
        </div>

        {result ? (
          <div {...stylex.props(styles.divFlexXs)}>
            {result.error ? (
              <p {...stylex.props(styles.p)}>
                {result.error === "no_column_could_run"
                  ? "No column could run; nothing was submitted."
                  : result.error}
              </p>
            ) : null}
            {(result.launched ?? []).map((column) => (
              <p key={column.label}>
                <span {...stylex.props(styles.spanMedium)}>{column.label}</span> — {String(column.runIds.length)}{" "}
                run(s) queued on {column.target}
              </p>
            ))}
            {(result.refused ?? []).map((refusal) => (
              <p key={`${refusal.modelVersionId}:${refusal.target}`} {...stylex.props(styles.refused)}>
                Refused ({refusal.code}): {refusal.reason}
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
