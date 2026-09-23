"use client";

import { useEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { reasoningRecord } from "@simforge-oss/evaluation/drive-evidence";
import { recordedStepAt, runFileUrl, runViewerHref, type JsonObject, type RecordedStep, type RunDirectoryView } from "../run-viewer-contract";
import { viewerStyles as s } from "../run-viewer.stylex";

function number(value: unknown, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "unavailable";
}

export function RunDirectoryViewer({ initialRef = "" }: { initialRef?: string }) {
  const [reference, setReference] = useState(initialRef);
  const [openedRef, setOpenedRef] = useState(initialRef);
  const [view, setView] = useState<RunDirectoryView | null>(null);
  const [steps, setSteps] = useState<Record<string, RecordedStep[]>>({});
  const [selected, setSelected] = useState("");
  const [time, setTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bevError, setBevError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => { setReference(initialRef); setOpenedRef(initialRef); }, [initialRef]);
  useEffect(() => {
    if (!openedRef) return;
    const abort = new AbortController();
    setView(null); setSteps({}); setError(null); setTime(0);
    void (async () => {
      const response = await fetch(`/api/simforge/drive/view?ref=${encodeURIComponent(openedRef)}`, { signal: abort.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Run could not be opened");
      const loaded = body as RunDirectoryView;
      const streams = await Promise.all(loaded.runs.map(async (run) => {
        if (!run.stepsUrl) return [run.ref, []] as const;
        const reply = await fetch(run.stepsUrl, { signal: abort.signal });
        if (!reply.ok) throw new Error(`Cannot read ${run.label} steps.jsonl`);
        const rows = (await reply.text()).split("\n").filter((line) => line.trim()).map((line) => {
          const row = JSON.parse(line) as RecordedStep;
          row.reasoning = reasoningRecord(row.reasoning);
          return row;
        });
        for (let i = 0; i < rows.length; i++) {
          if (rows[i]!.step !== i || !Number.isFinite(rows[i]!.tS) || (i > 0 && rows[i]!.tS <= rows[i - 1]!.tS)) throw new Error(`Invalid recorded decision sequence for ${run.label}`);
        }
        return [run.ref, rows] as const;
      }));
      if (abort.signal.aborted) return;
      setSteps(Object.fromEntries(streams)); setView(loaded);
      setSelected(loaded.runs.find((run) => run.label === "jev")?.ref ?? loaded.runs[0]!.ref);
    })().catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => abort.abort();
  }, [openedRef]);

  useEffect(() => {
    const element = video.current;
    if (!element?.requestVideoFrameCallback) return;
    let frame: number;
    const update = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      setTime(metadata.mediaTime); frame = element.requestVideoFrameCallback(update);
    };
    frame = element.requestVideoFrameCallback(update);
    return () => element.cancelVideoFrameCallback(frame);
  }, [view]);
  useEffect(() => setBevError(false), [selected]);

  const run = view?.runs.find((candidate) => candidate.ref === selected);
  const policyTime = view?.videoPolicyOffsetS != null ? time - view.videoPolicyOffsetS : null;
  const step = run && policyTime !== null ? recordedStepAt(steps[run.ref] ?? [], policyTime) : null;
  const reasoning = step?.reasoning;
  const probabilities = Object.entries(reasoning?.kind === "choice" ? reasoning.probabilities : {}).filter(([, value]) => Number.isFinite(value) && value >= 0 && value <= 1);
  const metrics = run?.result?.metrics as JsonObject | undefined;
  const health = metrics?.modelHealth as JsonObject | undefined;
  const fallbacks = health?.fallbacks as JsonObject | undefined;
  const passing = view?.runs.filter((candidate) => candidate.health.healthy).length ?? 0;
  const bev = step?.extras?.bev;

  return <div {...stylex.props(s.page)} data-testid="run-directory-viewer"><div {...stylex.props(s.container)}>
    <header {...stylex.props(s.row, s.spread)}>
      <div><div {...stylex.props(s.eyebrow)}>SimForge · recorded evidence</div><h1 {...stylex.props(s.title)}>Run viewer{view ? ` / ${view.kind === "heat" ? "Comparison heat" : run?.label ?? "Solo run"}` : ""}</h1></div>
      <a {...stylex.props(s.button, s.secondary)} href="/dashboard/map-assets/drive">Launch a run</a>
    </header>
    <form {...stylex.props(s.row)} onSubmit={(event) => { event.preventDefault(); setOpenedRef(reference.trim()); history.replaceState(null, "", runViewerHref(reference.trim())); }}>
      <input {...stylex.props(s.input, s.grow)} aria-label="Run directory or artifact id" placeholder="~/simforge-assets/runs/drive/… or artifact:id" value={reference} onChange={(event) => setReference(event.target.value)} required />
      <button {...stylex.props(s.button)} type="submit">Open run</button>
    </form>
    {error && <div role="alert" {...stylex.props(s.panel, s.bad)}>{error}</div>}
    {!view && !error && <p {...stylex.props(s.subtitle)}>{openedRef ? "Reading recorded video, decisions and health receipts…" : "Open a bench run or heat directory. Video + JSON playback; no browser simulation or WebGL."}</p>}
    {view && run && <>
      <div {...stylex.props(s.row, s.spread)}>
        <div {...stylex.props(s.row)}><span {...stylex.props(s.badge)}>{String(run.run.mode ?? "timing unavailable")}</span><span {...stylex.props(s.subtitle)}>{String(run.run.mapId ?? "map unavailable")} · seed {String(run.run.seed ?? "unavailable")}</span></div>
        <div data-testid="heat-health" {...stylex.props(s.badge, passing === view.runs.length ? s.good : s.bad)}>Model health: {passing}/{view.runs.length} clean{passing !== view.runs.length ? " · exploratory runs present" : ""}</div>
      </div>
      <div {...stylex.props(s.grid)}>
        <section {...stylex.props(s.stack)}>
          <div {...stylex.props(s.panel, s.stack)}>
            {view.videoUrl ? <video key={view.videoUrl} ref={video} {...stylex.props(s.video)} controls playsInline preload="auto" src={view.videoUrl} onLoadedMetadata={(event) => { if (view.videoPolicyOffsetS) event.currentTarget.currentTime = view.videoPolicyOffsetS; }} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onSeeked={(event) => setTime(event.currentTarget.currentTime)} onError={() => setError("Recorded video could not be decoded or read. Check the video artifact.")} aria-label="Recorded drive video" /> : <p>No recorded video in this run.</p>}
            <div {...stylex.props(s.row, s.spread)}><span {...stylex.props(s.subtitle)}>Playback {time.toFixed(2)} s · world {number(step?.tS)} s · decision {step?.step ?? "unavailable"}</span><span {...stylex.props(s.eyebrow)}>Kernel recording · read only</span></div>
            {policyTime === null ? <p {...stylex.props(s.subtitle)}>Video-to-policy timing was not recorded; decision HUD unavailable.</p> : policyTime < 0 ? <p {...stylex.props(s.subtitle)}>Recorded prologue · no policy decision yet.</p> : null}
          </div>
          <div {...stylex.props(s.row)} aria-label="Policy telemetry tabs">{view.runs.map((candidate) => <button key={candidate.ref} type="button" {...stylex.props(s.tab, candidate.ref === selected && s.activeTab)} aria-pressed={candidate.ref === selected} onClick={() => setSelected(candidate.ref)}>{candidate.label}</button>)}</div>
          <div {...stylex.props(s.panel, s.stats)} data-testid="decision-hud">
            <div><div {...stylex.props(s.subtitle)}>Speed · m/s</div><div {...stylex.props(s.value)}>{number(step?.pose?.speedMps)}</div></div>
            <div><div {...stylex.props(s.subtitle)}>Inference · ms</div><div {...stylex.props(s.value)}>{number(step?.latencyMs, 1)}</div></div>
            <div><div {...stylex.props(s.subtitle)}>Cross-track · m</div><div {...stylex.props(s.value)}>{number(step?.crossTrackM)}</div></div>
            <div><div {...stylex.props(s.subtitle)}>Applied</div><div {...stylex.props(s.value)}>{step?.applied ?? "unavailable"}</div></div>
          </div>
        </section>
        <aside {...stylex.props(s.stack)}>
          <section {...stylex.props(s.panel, s.stack)}>
            <h2 {...stylex.props(s.panelTitle)}>{run.label} · policy HUD</h2>
            {reasoning?.kind === "text" ? <p {...stylex.props(s.reasoning)}>{reasoning.text}</p> : reasoning?.kind === "choice" ? <>
              <div {...stylex.props(s.row, s.spread)}><strong>{reasoning.choice}</strong><span {...stylex.props(s.subtitle)}>confidence {number(reasoning.confidence)}</span></div>
              <p {...stylex.props(s.reasoning)}>{reasoning.question}</p>
              <div {...stylex.props(s.stack)} aria-label="Jev choice distributions">{probabilities.length ? probabilities.map(([choice, probability]) => <div key={choice} {...stylex.props(s.probability)}><span>{choice}</span><meter {...stylex.props(s.meter)} min={0} max={1} value={probability} aria-label={choice} /><span>{(100 * probability).toFixed(0)}%</span></div>) : <p {...stylex.props(s.subtitle)}>Probabilities unavailable — no distribution was reported.</p>}</div>
            </> : <p {...stylex.props(s.subtitle)}>No reasoning reported for this decision.</p>}
          </section>
          {bev != null && <section {...stylex.props(s.panel, s.stack)}><h2 {...stylex.props(s.panelTitle)}>Recorded model BEV · not ground truth</h2>{bevError ? <p role="alert">Unsupported or invalid recorded BEV payload.</p> : <img {...stylex.props(s.bev)} src={`/api/simforge/drive/bev?ref=${encodeURIComponent(run.ref)}&step=${step!.step}`} alt="Recorded model BEV inset" onError={() => setBevError(true)} />}<details><summary>BEV payload</summary><pre {...stylex.props(s.pre)}>{JSON.stringify(bev, null, 2)}</pre></details></section>}
          <section {...stylex.props(s.panel, s.stack)} data-testid="health-verdict">
            <h2 {...stylex.props(s.panelTitle)}>Model health verdict</h2>
            <strong {...stylex.props(run.health.healthy ? s.good : s.bad)}>{run.health.healthy ? "CLEAN MODEL HEALTH" : "EXPLORATORY · NOT QUALIFIED"}</strong>
            {!run.health.healthy && <p {...stylex.props(s.reasoning)}>{run.health.reasons.join("; ")}</p>}
            <div {...stylex.props(s.stats)}><div><div {...stylex.props(s.subtitle)}>Closed-loop fallbacks</div><strong>{number(fallbacks?.closedLoop, 0)}</strong></div><div><div {...stylex.props(s.subtitle)}>Invalid plans</div><strong>{number(health?.invalidPlans, 0)}</strong></div><div><div {...stylex.props(s.subtitle)}>Genuine plans</div><strong>{number(health?.genuinePlans, 0)}</strong></div></div>
            <div {...stylex.props(s.subtitle)}>Clean health is not a driving-safety or held-out-evaluation qualification. Manifest status: {String(run.result?.status ?? "incomplete")}; promotable: {String(run.result?.promotable ?? false)}.</div>
          </section>
        </aside>
      </div>
      <section {...stylex.props(s.cards)} aria-label="Scores and solo clips">{view.runs.map((candidate) => {
        const score = candidate.score;
        return <article key={candidate.ref} {...stylex.props(s.panel, s.stack)}><div {...stylex.props(s.row, s.spread)}><h2 {...stylex.props(s.panelTitle)}>{candidate.label}</h2><span {...stylex.props(s.badge, candidate.health.healthy ? s.good : s.bad)}>{candidate.health.healthy ? "health clean" : "exploratory"}</span></div><div {...stylex.props(s.value)}>{number(score?.drivingScore, 4)}</div><div {...stylex.props(s.subtitle)}>Driving score · completion {number(score?.routeCompletion, 4)}</div><div {...stylex.props(s.row)}><a {...stylex.props(s.button, s.secondary)} href={runViewerHref(candidate.ref)}>Open solo run</a>{(candidate.soloClipUrl ?? candidate.videoUrl) && <a {...stylex.props(s.subtitle)} href={candidate.soloClipUrl ?? candidate.videoUrl!}>Solo clip</a>}</div></article>;
      })}</section>
      <section {...stylex.props(s.panel, s.stack)}><h2 {...stylex.props(s.panelTitle)}>Recorded evidence · {run.label}</h2><div {...stylex.props(s.row)}>{["result.json", "score.json", "steps.jsonl", "run.json", "log.txt"].map((file) => <a key={file} {...stylex.props(s.subtitle)} href={runFileUrl(run.ref, file)}>{file}</a>)}</div>{[["Result + modelHealth", run.result], ["Score", run.score], ["Run provenance", run.run], ...(view.report ? [["Heat report", view.report]] : [])].map(([label, value]) => <details key={String(label)}><summary>{String(label)}</summary><pre {...stylex.props(s.pre)}>{JSON.stringify(value, null, 2)}</pre></details>)}</section>
    </>}
  </div></div>;
}
