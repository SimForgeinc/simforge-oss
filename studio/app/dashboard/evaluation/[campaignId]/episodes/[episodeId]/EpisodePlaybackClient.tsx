"use client";
import * as stylex from "@stylexjs/stylex";

import { ArrowLeft, Pause, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@simforge-oss/studio-ui/components/ui/card";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import type {
  EvalEpisodePayload,
  EvalEvent,
  EvalViewTick,
} from "@/app/lib/evaluation/contracts";
import { formatScore, PanelMessage, StatusBadge, useJsonFetch } from "../../../shared";
import { styles } from "../../../route-residuals.stylex";

const EVENT_COLOR: Record<EvalEvent["severity"], string> = {
  info: "#38bdf8",
  warning: "#f59e0b",
  infraction: "#ef4444",
};

const CHART_WIDTH = 720;
const CHART_HEIGHT = 160;

/** Speed-over-time SVG chart with a playback cursor and event markers. */
function EgoSpeedChart({
  ticks,
  events,
  cursor,
  onSeek,
}: {
  ticks: EvalViewTick[];
  events: EvalEvent[];
  cursor: number;
  onSeek: (index: number) => void;
}) {
  const maxT = ticks[ticks.length - 1]?.tS ?? 1;
  const maxSpeed = Math.max(1, ...ticks.map((tick) => tick.speedMps));
  const xOf = (tS: number) => (tS / Math.max(0.001, maxT)) * CHART_WIDTH;
  const yOf = (speed: number) => CHART_HEIGHT - 14 - (speed / maxSpeed) * (CHART_HEIGHT - 34);
  const path = ticks
    .map(
      (tick, index) =>
        `${index === 0 ? "M" : "L"}${xOf(tick.tS).toFixed(1)},${yOf(tick.speedMps).toFixed(1)}`,
    )
    .join(" ");
  const cursorTS = ticks[cursor]?.tS ?? 0;

  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      {...stylex.props(styles.chart)}
      data-testid="ego-speed-chart"
      onClick={(mouse) => {
        const rect = mouse.currentTarget.getBoundingClientRect();
        const fraction = (mouse.clientX - rect.left) / rect.width;
        onSeek(Math.round(fraction * (ticks.length - 1)));
      }}
    >
      <text x={6} y={14} {...stylex.props(styles.tinyMuted)}>
        ego speed (m/s), max {maxSpeed.toFixed(1)}
      </text>
      <path d={path} fill="none" stroke="hsl(160 84% 39%)" strokeWidth={1.6} />
      {events.map((event, index) => (
        <g key={`${event.tick}-${index}`}>
          <line
            x1={xOf(event.tS)}
            x2={xOf(event.tS)}
            y1={20}
            y2={CHART_HEIGHT - 12}
            stroke={EVENT_COLOR[event.severity]}
            strokeOpacity={0.55}
            strokeDasharray={event.severity === "info" ? "2 3" : undefined}
          />
          <circle cx={xOf(event.tS)} cy={CHART_HEIGHT - 8} r={3} fill={EVENT_COLOR[event.severity]} />
        </g>
      ))}
      <line
        x1={xOf(cursorTS)}
        x2={xOf(cursorTS)}
        y1={4}
        y2={CHART_HEIGHT - 4}
        stroke="hsl(0 0% 98%)"
        strokeWidth={1.4}
      />
    </svg>
  );
}

/** Top-down ego path with the current position dot. */
function PathPlot({ ticks, cursor }: { ticks: EvalViewTick[]; cursor: number }) {
  const bounds = useMemo(() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const tick of ticks) {
      minX = Math.min(minX, tick.x);
      maxX = Math.max(maxX, tick.x);
      minY = Math.min(minY, tick.y);
      maxY = Math.max(maxY, tick.y);
    }
    const pad = Math.max(2, (maxX - minX) * 0.05, (maxY - minY) * 0.05);
    return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
  }, [ticks]);

  const width = 300;
  const height = 160;
  const xOf = (x: number) => ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * width;
  const yOf = (y: number) => height - ((y - bounds.minY) / (bounds.maxY - bounds.minY)) * height;
  const current = ticks[cursor];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      {...stylex.props(styles.chartStatic)}
      data-testid="path-plot"
    >
      <text x={6} y={14} {...stylex.props(styles.tinyMuted)}>
        top-down path (m)
      </text>
      <path
        d={ticks
          .map(
            (tick, index) =>
              `${index === 0 ? "M" : "L"}${xOf(tick.x).toFixed(1)},${yOf(tick.y).toFixed(1)}`,
          )
          .join(" ")}
        fill="none"
        stroke="hsl(215 20% 55%)"
        strokeWidth={1.2}
      />
      {current ? <circle cx={xOf(current.x)} cy={yOf(current.y)} r={4} fill="hsl(160 84% 39%)" /> : null}
    </svg>
  );
}

/** Latest decision at or before the cursor carrying the wanted field. */
function latestAtOrBefore<T>(
  ticks: EvalViewTick[],
  cursor: number,
  pick: (tick: EvalViewTick) => T | null,
): { tick: EvalViewTick; value: T } | null {
  for (let index = Math.min(cursor, ticks.length - 1); index >= 0; index -= 1) {
    const tick = ticks[index];
    if (!tick) continue;
    const value = pick(tick);
    if (value !== null) return { tick, value };
  }
  return null;
}

export function EpisodePlaybackClient({
  campaignId,
  episodeId,
}: {
  campaignId: string;
  episodeId: string;
}) {
  useSetPageTitle("Evaluation");
  const state = useJsonFetch<EvalEpisodePayload>(
    `/api/evaluation/campaigns/${campaignId}/episodes/${episodeId}`,
  );
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);

  const ticks = state.kind === "ready" ? state.data.ticks : [];
  useEffect(() => {
    if (!playing || ticks.length === 0) return;
    const interval = window.setInterval(() => {
      setCursor((current) => {
        if (current + 1 >= ticks.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [playing, ticks.length]);

  if (state.kind === "loading") return <PanelMessage>Loading episode…</PanelMessage>;
  if (state.kind === "error") {
    return <PanelMessage>Failed to load episode: {state.message}</PanelMessage>;
  }
  const payload = state.data;
  const current = ticks[cursor];
  const reasoning = latestAtOrBefore(ticks, cursor, (tick) => tick.reasoning);
  const frames = latestAtOrBefore(ticks, cursor, (tick) => tick.thumbs);
  const anyFrames = ticks.some((tick) => tick.thumbs);
  const policyId = payload.provenance?.policy.policyId ?? payload.score?.policyId ?? null;

  return (
    <div {...stylex.props(styles.shell)} >
      <PageHeader
        eyebrow={campaignId}
        title={payload.score?.scenarioId ?? episodeId}
        description={`Episode ${episodeId}`}
        actions={
          <>
            <StatusBadge status={payload.complete ? "complete" : "running"} />
            <Badge variant="secondary" {...stylex.props(styles.mono)} >
              score {formatScore(payload.score?.drivingScore)}
            </Badge>
            {policyId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/dashboard/evaluation/${campaignId}/policies/${policyId}`}>
                  <ArrowLeft {...stylex.props(styles.icon)} />
                  {policyId}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <div {...stylex.props(styles.content4)} >
        {ticks.length === 0 ? (
          <PanelMessage>No trace.jsonl for this episode — nothing to play back.</PanelMessage>
        ) : (
          <>
            <Card>
              <CardContent xstyle={styles.cardStack3Top}>
                <EgoSpeedChart
                  ticks={ticks}
                  events={payload.events}
                  cursor={cursor}
                  onSeek={(index) => setCursor(Math.max(0, Math.min(ticks.length - 1, index)))}
                />
                <div {...stylex.props(styles.controls)}>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="playback-toggle"
                    onClick={() => setPlaying((value) => !value)}
                  >
                    {playing ? <Pause {...stylex.props(styles.iconBare)} /> : <Play {...stylex.props(styles.iconBare)} />}
                  </Button>
                  <input
                    type="range"
                    {...stylex.props(styles.range)}
                    min={0}
                    max={ticks.length - 1}
                    value={cursor}
                    data-testid="playback-scrubber"
                    onChange={(change) => {
                      setPlaying(false);
                      setCursor(Number(change.target.value));
                    }}
                  />
                  <span {...stylex.props(styles.time)}>
                    step {current?.step ?? 0}/{ticks[ticks.length - 1]?.step ?? 0} ·{" "}
                    {(current?.tS ?? 0).toFixed(1)}s
                  </span>
                </div>
              </CardContent>
            </Card>

            <div {...stylex.props(styles.grid3)} >
              <Card>
                <CardHeader {...stylex.props(styles.cardHeaderTight)} >
                  <CardTitle {...stylex.props(styles.cardTitleSmall)}>Ego state</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl {...stylex.props(styles.dlState)} >
                    {current
                      ? (
                          [
                            ["x", `${current.x.toFixed(2)} m`],
                            ["y", `${current.y.toFixed(2)} m`],
                            ["yaw", `${current.yawRad.toFixed(3)} rad`],
                            ["v", `${current.speedMps.toFixed(2)} m/s`],
                            ["accel", `${current.accelMps2.toFixed(2)} m/s²`],
                            ["lat off", `${current.latOffM.toFixed(2)} m`],
                          ] as const
                        ).map(([label, value]) => (
                          <div key={label}>
                            <dt {...stylex.props(styles.tinyMuted)}>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))
                      : null}
                  </dl>
                  <div style={{ marginTop: ".75rem" }}>
                    <PathPlot ticks={ticks} cursor={cursor} />
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="reasoning-panel">
                <CardHeader {...stylex.props(styles.cardHeaderTight)} >
                  <CardTitle {...stylex.props(styles.cardTitleSmall)}>Policy reasoning</CardTitle>
                  <CardDescription {...stylex.props(styles.monoSmall)}>
                    {current
                      ? `decision #${current.step}` +
                        (current.inferMs !== null ? ` · infer ${current.inferMs} ms` : "") +
                        (current.miss ? " · DEADLINE MISS" : "")
                      : "—"}
                  </CardDescription>
                </CardHeader>
                <CardContent xstyle={styles.cardStack3}>
                  <p {...stylex.props(styles.whitespace)}>
                    {reasoning
                      ? reasoning.value
                      : "This trace carries no reasoning text — showing raw decision data."}
                  </p>
                  {reasoning && reasoning.tick.step !== current?.step ? (
                    <p {...stylex.props(styles.tinyMuted, styles.mono)}>
                      from decision #{reasoning.tick.step} (latest with reasoning)
                    </p>
                  ) : null}
                  {current ? (
                    <div {...stylex.props(styles.actionData)}>
                      a={JSON.stringify(current.action)} rw={current.rw ?? "—"}
                      {current.roundtripMs !== null ? ` roundtrip=${current.roundtripMs}ms` : ""}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Card data-testid="frames-panel">
                <CardHeader {...stylex.props(styles.cardHeaderTight)} >
                <CardTitle {...stylex.props(styles.cardTitleSmall)}>Camera frames</CardTitle>
                <CardDescription {...stylex.props(styles.monoSmall)}>
                    {anyFrames
                      ? frames
                        ? `bundle recording @ step ${frames.tick.step}`
                        : "no frame at cursor yet"
                      : "no bundle recording for this episode"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {frames ? (
                    <div {...stylex.props(styles.frames)}>
                      {Object.entries(frames.value).map(([cam, relativePath]) => (
                        <figure key={cam}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            alt={`${cam} camera at step ${frames.tick.step}`}
                            {...stylex.props(styles.image)}
                            src={`/api/evaluation/campaigns/${campaignId}/episodes/${episodeId}/frames/${relativePath}`}
                          />
                          <figcaption {...stylex.props(styles.centerCaption, styles.monoTiny, styles.muted)}>
                            {cam}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  ) : (
                    <PanelMessage>Playback continues without imagery.</PanelMessage>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader {...stylex.props(styles.cardHeaderTight)} >
                <CardTitle {...stylex.props(styles.cardTitleSmall)}>Events</CardTitle>
                <CardDescription>
                  {payload.events.length} recorded · markers drawn on the timeline
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul {...stylex.props(styles.list)}>
                  {payload.events.map((event, index) => {
                    const reached = current ? event.tS <= current.tS : false;
                    return (
                      <li
                        key={`${event.tick}-${index}`}
                        {...stylex.props(
                          styles.event,
                          reached ? styles.reached : styles.unreached,
                        )}
                      >
                        <span
                          {...stylex.props(styles.dot)}
                          style={{ backgroundColor: EVENT_COLOR[event.severity] }}
                        />
                        <button
                          type="button"
                          {...stylex.props(styles.monoSmall, styles.muted, styles.link)}
                          onClick={() => {
                            const target = ticks.findIndex((tick) => tick.tS >= event.tS);
                            if (target >= 0) setCursor(target);
                          }}
                        >
                          t={event.tS.toFixed(1)}s
                        </button>
                        <span {...stylex.props(styles.monoSmall)}>{event.type}</span>
                        <Badge
                          variant={event.severity === "infraction" ? "destructive" : "secondary"}
                          {...stylex.props(styles.tinyMuted)}
                        >
                          {event.severity}
                        </Badge>
                        {event.position ? (
                          <span {...stylex.props(styles.eventPosition)}>
                            ({event.position.x.toFixed(1)}, {event.position.y.toFixed(1)})
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
