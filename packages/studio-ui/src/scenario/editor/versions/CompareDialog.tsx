"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Pause, Play } from "lucide-react";
import type { SimulationComparisonDto } from "@simforge-oss/studio-host";

import { Chip } from "../../../components/ui/chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { IconButton } from "../../../components/ui/icon-button";
import { Spinner } from "../../../components/ui/spinner";
import { useStudioHost } from "../../../host";
import { hairline, surface, typography } from "../../../stylex/recipes.stylex";
import { art } from "./CompareDialog.stylex";
import { diffChip, engineLabel } from "./versions-model";
import { styles } from "./versions.stylex";

type Bounds = { minX: number; minY: number; width: number; height: number };

function bounds(comparison: SimulationComparisonDto): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const frame of comparison.playback.frames) {
    for (const pair of Object.values(frame.actors)) {
      for (const pose of [pair.canonical, pair.external]) {
        if (!pose?.present) continue;
        minX = Math.min(minX, pose.x); maxX = Math.max(maxX, pose.x);
        minY = Math.min(minY, pose.y); maxY = Math.max(maxY, pose.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: -10, minY: -10, width: 20, height: 20 };
  const pad = Math.max(5, 0.08 * Math.max(maxX - minX, maxY - minY));
  return { minX: minX - pad, minY: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}

/** Each actor's path as an SVG polyline (y flipped: xodr-local y is north, SVG y is down). */
function paths(comparison: SimulationComparisonDto, side: "canonical" | "external", box: Bounds): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const frame of comparison.playback.frames) {
    for (const [id, pair] of Object.entries(frame.actors)) {
      const pose = pair[side];
      if (!pose?.present) continue;
      const points = out.get(id) ?? [];
      points.push(`${(pose.x - box.minX).toFixed(2)},${(box.height - (pose.y - box.minY)).toFixed(2)}`);
      out.set(id, points);
    }
  }
  return new Map([...out].map(([id, points]) => [id, points.join(" ")]));
}

/**
 * OWNS: Compare, two simulations of one version side by side: both motions over the whole clip
 * on a top-down stage (base solid, candidate dashed), played back together, with the motion diff.
 */
export function CompareDialog({
  baseSimKey,
  candidateSimKey,
  title,
  onClose,
}: {
  baseSimKey: string | null;
  candidateSimKey: string | null;
  title: string;
  onClose: () => void;
}) {
  const studioHost = useStudioHost();
  const open = Boolean(baseSimKey && candidateSimKey);
  const [comparison, setComparison] = useState<SimulationComparisonDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (!baseSimKey || !candidateSimKey) return;
    const abort = new AbortController();
    setComparison(null);
    setError(null);
    setFrame(0);
    studioHost.projects.compareSimulations(baseSimKey, candidateSimKey, abort.signal)
      .then(setComparison)
      .catch((reason: unknown) => {
        if ((reason as { name?: string } | null)?.name !== "AbortError") setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => abort.abort();
  }, [baseSimKey, candidateSimKey, studioHost]);

  useEffect(() => {
    if (!playing || !comparison) return;
    const frames = comparison.playback.frames.length;
    const stepMs = 1000 / comparison.playback.sampleHz;
    let last = performance.now();
    const tick = (now: number) => {
      if (now - last >= stepMs) {
        last = now;
        setFrame((current) => {
          if (current + 1 >= frames) {
            setPlaying(false);
            return current;
          }
          return current + 1;
        });
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [comparison, playing]);

  const box = useMemo(() => (comparison ? bounds(comparison) : null), [comparison]);
  const basePaths = useMemo(() => (comparison && box ? paths(comparison, "canonical", box) : new Map()), [comparison, box]);
  const candidatePaths = useMemo(() => (comparison && box ? paths(comparison, "external", box) : new Map()), [comparison, box]);
  const current = comparison?.playback.frames[Math.min(frame, (comparison?.playback.frames.length ?? 1) - 1)];
  const chip = comparison ? diffChip(comparison.diff, true) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setPlaying(false); onClose(); } }}>
      <DialogContent size="xl" data-testid="scenario-compare-dialog">
        <DialogHeader>
          <DialogTitle>Compare simulations</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error ? <p {...stylex.props(typography.bodySm)} role="alert">The comparison could not be loaded: {error}</p> : null}
          {!comparison && !error ? <Spinner label="Comparing simulations" /> : null}
          {comparison && box && current ? (
            <div {...stylex.props(styles.compareBody)}>
              <div {...stylex.props(styles.compareLegend)}>
                <span {...stylex.props(typography.meta)}><span {...stylex.props(art.legendBase)} /> {engineLabel(comparison.base.engineSemVer)} (active)</span>
                <span {...stylex.props(typography.meta)}><span {...stylex.props(art.legendCandidate)} /> {engineLabel(comparison.candidate.engineSemVer)}</span>
                {chip ? <Chip tone={chip.tone} title={chip.title} data-testid="scenario-compare-diff">{chip.text}</Chip> : null}
              </div>
              <svg
                {...stylex.props(surface.plate, hairline.all, styles.compareStage)}
                viewBox={`0 0 ${box.width.toFixed(2)} ${box.height.toFixed(2)}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={`Top-down paths of both simulations; ${chip?.text ?? ""}`}
                data-testid="scenario-compare-stage"
              >
                {[...basePaths].map(([id, points]) => <polyline key={`b-${id}`} points={points} {...stylex.props(art.basePath, art.path)} />)}
                {[...candidatePaths].map(([id, points]) => <polyline key={`c-${id}`} points={points} {...stylex.props(art.candidatePath, art.path)} />)}
                {Object.entries(current.actors).map(([id, pair]) => {
                  const a = pair.canonical?.present ? pair.canonical : null;
                  const b = pair.external?.present ? pair.external : null;
                  const toX = (x: number) => x - box.minX;
                  const toY = (y: number) => box.height - (y - box.minY);
                  const radius = Math.max(0.6, box.width / 150);
                  return (
                    <g key={id} data-actor={id}>
                      {a && b ? <line x1={toX(a.x)} y1={toY(a.y)} x2={toX(b.x)} y2={toY(b.y)} {...stylex.props(art.errorLine, art.path)} /> : null}
                      {a ? <circle cx={toX(a.x)} cy={toY(a.y)} r={radius} {...stylex.props(art.baseMarker)} /> : null}
                      {b ? <circle cx={toX(b.x)} cy={toY(b.y)} r={radius * 0.7} {...stylex.props(art.candidateMarker)} /> : null}
                    </g>
                  );
                })}
              </svg>
              <div {...stylex.props(styles.compareControls)}>
                <IconButton
                  label={playing ? "Pause" : "Play both simulations"}
                  onClick={() => {
                    if (!playing && frame >= comparison.playback.frames.length - 1) setFrame(0);
                    setPlaying(!playing);
                  }}
                  size="sm"
                  data-testid="scenario-compare-play"
                >
                  {playing ? <Pause /> : <Play />}
                </IconButton>
                <input
                  {...stylex.props(styles.compareScrubber)}
                  aria-label="Clip time"
                  max={comparison.playback.frames.length - 1}
                  min={0}
                  onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }}
                  step={1}
                  type="range"
                  value={frame}
                  data-testid="scenario-compare-scrubber"
                />
                <span {...stylex.props(typography.numeric)} data-testid="scenario-compare-time">{current.t.toFixed(1)} s</span>
              </div>
              <dl {...stylex.props(typography.meta, styles.compareTable)}>
                <dt {...stylex.props(styles.compareCell)}>Largest position change</dt>
                <dd {...stylex.props(typography.numeric, styles.compareCell)}>{comparison.diff.maxPositionErrorM.toFixed(3)} m</dd>
                <dt {...stylex.props(styles.compareCell)}>Largest heading change</dt>
                <dd {...stylex.props(typography.numeric, styles.compareCell)}>{comparison.diff.maxHeadingErrorDeg.toFixed(2)}°</dd>
                <dt {...stylex.props(styles.compareCell)}>Actors changed</dt>
                <dd {...stylex.props(typography.numeric, styles.compareCell)}>
                  {comparison.diff.actors.changedCount + comparison.diff.actors.added.length + comparison.diff.actors.removed.length}
                </dd>
                <dt {...stylex.props(styles.compareCell)}>Events changed</dt>
                <dd {...stylex.props(typography.numeric, styles.compareCell)}>{comparison.diff.eventsChanged + comparison.diff.collisionsChanged}</dd>
                <dt {...stylex.props(styles.compareCell)}>Strict trajectory check</dt>
                <dd {...stylex.props(styles.compareCell)} title={comparison.diff.strict.reason ?? ""}>{comparison.diff.strict.verdict}</dd>
              </dl>
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
