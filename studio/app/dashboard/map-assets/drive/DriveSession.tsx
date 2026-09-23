"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import type { ScenarioMapEntry } from "@simforge-oss/editor";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { ambientTrafficProviderFromExtensions, previewAmbientTrafficProfile } from "@simforge-oss/playback/traffic";
import { playbackMapEntry } from "@simforge-oss/studio-ui/lib/scenario/maps";
import { ScenarioWorkerClient } from "@simforge-oss/studio-ui/lib/scenario/playback/scenarioWorkerClient";
import { runViewerHref } from "../../evaluation/run-viewer-contract";
import { viewerStyles as s } from "../../evaluation/run-viewer.stylex";

/** Authoring can materialize an input; only the bench kernel may execute it. */
export function DriveSession({ content, map, roleId, label, initialScenario = "", onExit }: {
  content?: ScenarioTemplateV2;
  map?: ScenarioMapEntry;
  roleId?: string;
  label?: string;
  initialScenario?: string;
  onExit?: () => void;
}) {
  const router = useRouter();
  const [scenario, setScenario] = useState(initialScenario);
  const [policy, setPolicy] = useState("scripted");
  const [seed, setSeed] = useState(42);
  const [duration, setDuration] = useState(10);
  const [status, setStatus] = useState("idle");
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stream = useRef<EventSource | null>(null);
  const busy = status === "submitting" || status === "queued" || status === "running";
  useEffect(() => () => stream.current?.close(), []);

  async function start(selectedPolicy: string) {
    if (busy) return;
    setStatus("submitting"); setError(null); setLog("");
    try {
      let input: unknown;
      if (!scenario.trim() && content && map) {
        const compiler = new ScenarioWorkerClient();
        try {
          const bundle = await compiler.prepare(content, playbackMapEntry(map), previewAmbientTrafficProfile(ambientTrafficProviderFromExtensions(content.extensions), content.extensions, content.mapSignalPlans.length > 0), undefined, { materializeOnly: true });
          const compiled = bundle.instance.input;
          const actor = roleId ? compiled.actors.find((candidate) => candidate.tags.includes(`role:${roleId}`)) : null;
          if (roleId && !actor) throw new Error(`Compiler did not bind authored role ${roleId}`);
          input = actor ? { ...compiled, metricSubject: actor.id } : compiled;
        } finally { compiler.dispose(); }
      }
      const response = await fetch("/api/simforge/drive/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario, input, scenarioId: label || "studio-scenario", policy: selectedPolicy, seed, duration }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Bench submission failed");
      setStatus(body.job.status);
      stream.current?.close();
      const events = new EventSource(`/api/simforge/drive/jobs/${encodeURIComponent(body.job.id)}/events`);
      stream.current = events;
      events.onmessage = (event) => {
        const update = JSON.parse(event.data);
        setStatus(update.status); setLog(update.log);
        if (update.status === "succeeded" || update.status === "failed") {
          events.close();
          if (update.runDir) router.push(runViewerHref(update.runDir));
          else setError("Bench failed. The retained worker log below contains the failure; no verified result was published.");
        }
      };
      events.onerror = () => { events.close(); setStatus("disconnected"); setError(`Progress connection lost. The job is retained as ${body.job.id}; inspect it in Evaluation before submitting another run.`); };
    } catch (cause) {
      setStatus("failed"); setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <div {...stylex.props(s.page)} data-testid="drive-launcher"><div {...stylex.props(s.container)}>
    <header {...stylex.props(s.row, s.spread)}><div><div {...stylex.props(s.eyebrow)}>Native kernel · local job</div><h1 {...stylex.props(s.title)}>Launch a drive bench run</h1></div><div {...stylex.props(s.row)}><a {...stylex.props(s.button, s.secondary)} href="/dashboard/evaluation/viewer">Open recorded run</a>{onExit && <button {...stylex.props(s.button, s.secondary)} type="button" onClick={onExit}>Back</button>}</div></header>
    <p {...stylex.props(s.subtitle)}>Studio submits a frozen scenario to the local worker, streams log.txt, and opens verified video + JSON evidence. The kernel owns stepping, cameras and scoring. No live takeover or browser driving loop.</p>
    <form {...stylex.props(s.panel, s.stack)} onSubmit={(event) => { event.preventDefault(); void start(policy); }}>
      {content && <p {...stylex.props(s.subtitle)}>Authored scenario: {label ?? "current document"}. Leave the path empty to materialize this document without playing it.</p>}
      <label {...stylex.props(s.field)}>Scenario instance / episodes.json path<input {...stylex.props(s.input)} aria-label="Scenario path" placeholder="/absolute/path/to/scenario.episodes.json" required={!content} value={scenario} onChange={(event) => setScenario(event.target.value)} disabled={busy} /></label>
      <div {...stylex.props(s.row)}><label {...stylex.props(s.field)}>Policy<input {...stylex.props(s.input)} list="bench-policies" aria-label="Policy" value={policy} onChange={(event) => setPolicy(event.target.value)} required disabled={busy} /><datalist id="bench-policies">{["scripted", "jev", "alpamayo-1.5", "qwen-drive", "auto-e2e"].map((id) => <option key={id} value={id} />)}</datalist></label><label {...stylex.props(s.field)}>Seed<input {...stylex.props(s.input)} aria-label="Seed" type="number" min={0} step={1} value={seed} onChange={(event) => setSeed(Number(event.target.value))} required disabled={busy} /></label><label {...stylex.props(s.field)}>Policy duration · seconds<input {...stylex.props(s.input)} aria-label="Duration seconds" type="number" min={0.1} max={3600} step={0.1} value={duration} onChange={(event) => setDuration(Number(event.target.value))} required disabled={busy} /></label></div>
      <div {...stylex.props(s.row)}><button {...stylex.props(s.button)} type="submit" disabled={busy}>{busy ? "Bench running…" : "Start run"}</button><button {...stylex.props(s.button, s.secondary)} type="button" disabled={busy} onClick={() => { setPolicy("jev"); void start("jev"); }}>Run with policy jev</button><span {...stylex.props(s.badge)}>offline-simtime</span><span role="status" {...stylex.props(s.subtitle)}>{status}</span></div>
    </form>
    {error && <p role="alert" {...stylex.props(s.panel, s.bad)}>{error}</p>}
    {status !== "idle" && <section {...stylex.props(s.panel, s.stack)}><h2 {...stylex.props(s.panelTitle)}>Worker + bench log.txt</h2><pre {...stylex.props(s.pre, s.log)} aria-label="Bench progress log">{log || "Waiting for the local worker to claim this run…"}</pre></section>}
  </div></div>;
}
