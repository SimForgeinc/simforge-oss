"use client";

import { useEffect, useMemo, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type {
  ScenarioMapRepinPreviewDto,
  ScenarioMapTransitionPlacementDto,
  ScenarioMapTransitionPlanDto,
  ScenarioMapTransitionRoadDto,
} from "@simforge-oss/studio-host";

import { Button } from "../../../components/ui/button";
import { Chip } from "../../../components/ui/chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Dot } from "../../../components/ui/dot";
import { Spinner } from "../../../components/ui/spinner";
import { useStudioHost } from "../../../host";
import { hairline, surface, textLayout, typography } from "../../../stylex/recipes.stylex";
import { art, styles } from "./MapTransitionDialog.stylex";
import { diffChip, shortDate } from "./versions-model";

const PREVIEW_WAIT_MS = 20_000;
const PREVIEW_ATTEMPTS = 6;

type Box = { minX: number; minY: number; width: number; height: number };

const STATUS_TONE = { kept: "positive", moved: "accent", flagged: "critical", unplaced: "critical" } as const;
const STATUS_LABEL = { kept: "Kept", moved: "Moved", flagged: "Check", unplaced: "Not placed" } as const;

function extent(plan: ScenarioMapTransitionPlanDto): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const placement of plan.placements) {
    if (placement.before) add(placement.before.x, placement.before.y);
    if (placement.after) add(placement.after.x, placement.after.y);
  }
  if (!Number.isFinite(minX)) {
    for (const road of plan.roads) for (const line of [...road.before, ...road.after]) for (const [x, y] of line) add(x, y);
  }
  if (!Number.isFinite(minX)) return { minX: -50, minY: -50, width: 100, height: 100 };
  const pad = Math.max(25, 0.15 * Math.max(maxX - minX, maxY - minY));
  return { minX: minX - pad, minY: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}

function roadStyle(road: ScenarioMapTransitionRoadDto, side: "before" | "after") {
  if (road.change === "elevation") return art.roadElevation;
  if (road.change === "geometry") return art.roadGeometry;
  if (road.change === "added" && side === "after") return art.roadGeometry;
  if (road.change === "removed" && side === "before") return art.roadRemoved;
  return art.road;
}

/** One side of the transition: the roads of that map version and every actor where it starts there. */
function Stage({ plan, side, box }: { plan: ScenarioMapTransitionPlanDto; side: "before" | "after"; box: Box }) {
  const toX = (x: number) => x - box.minX;
  const toY = (y: number) => box.height - (y - box.minY);
  const radius = Math.max(0.8, box.width / 120);
  return (
    <svg
      {...stylex.props(surface.plate, hairline.all, styles.stage)}
      viewBox={`0 0 ${box.width.toFixed(1)} ${box.height.toFixed(1)}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={side === "before" ? "The scenario on the current map version" : "The scenario on the new map version"}
      data-testid={`map-transition-${side}`}
    >
      {plan.roads.flatMap((road) => road[side].map((line, index) => (
        <polyline
          key={`${road.roadId}-${index}`}
          points={line.map(([x, y]) => `${toX(x).toFixed(1)},${toY(y).toFixed(1)}`).join(" ")}
          {...stylex.props(roadStyle(road, side))}
          data-road-change={road.change}
        />
      )))}
      {plan.placements.map((placement) => {
        const pose = side === "before" ? placement.before : placement.after;
        if (!pose) {
          const at = placement.before;
          if (side !== "after" || !at) return null;
          const cx = toX(at.x), cy = toY(at.y), r = radius * 1.4;
          return (
            <g key={placement.roleId} data-placement={placement.status}>
              <line x1={cx - r} y1={cy - r} x2={cx + r} y2={cy + r} {...stylex.props(art.unplaced)} />
              <line x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} {...stylex.props(art.unplaced)} />
            </g>
          );
        }
        const fill = side === "before" || placement.status === "kept"
          ? art.actorKept
          : placement.status === "moved" ? art.actorMoved : art.actorFlagged;
        const cx = toX(pose.x), cy = toY(pose.y);
        return (
          <g key={placement.roleId} data-placement={placement.status}>
            <line x1={cx} y1={cy} x2={cx + Math.cos(pose.headingRad) * radius * 2.5} y2={cy - Math.sin(pose.headingRad) * radius * 2.5} {...stylex.props(art.actorHeading)} />
            <circle cx={cx} cy={cy} r={placement.isSubject ? radius * 1.3 : radius} {...stylex.props(fill)} />
          </g>
        );
      })}
    </svg>
  );
}

function PlacementRow({ placement }: { placement: ScenarioMapTransitionPlacementDto }) {
  const at = placement.before ?? placement.after;
  return (
    <li {...stylex.props(styles.placement)} data-testid="map-transition-placement" data-status={placement.status}>
      <Dot tone={STATUS_TONE[placement.status]} />
      <span {...stylex.props(typography.bodySm, textLayout.truncate)}>
        {placement.label}{placement.isSubject ? " (subject)" : ""}
        {placement.reason ? ` · ${placement.reason}` : ""}
        {placement.status !== "kept" && at ? ` · at x ${at.x.toFixed(1)}, y ${at.y.toFixed(1)}` : ""}
      </span>
      <Chip tone={STATUS_TONE[placement.status]}>
        {STATUS_LABEL[placement.status]}{placement.displacementM !== null && placement.status !== "kept" ? ` ${placement.displacementM.toFixed(2)} m` : ""}
      </Chip>
    </li>
  );
}

/**
 * OWNS: the map version transition. Before and after side by side: the scenario on the map version
 * it is pinned to and on the newer one, changed roads highlighted, every actor's placement, and how
 * the motion changes. One action moves; the state before the move is always kept as a version.
 */
export function MapTransitionDialog({
  documentId,
  targetMapVersionId,
  open,
  onClose,
  onMove,
}: {
  documentId: string;
  targetMapVersionId: string;
  open: boolean;
  onClose: () => void;
  onMove: (targetMapVersionId: string) => Promise<void>;
}) {
  const studioHost = useStudioHost();
  const [preview, setPreview] = useState<ScenarioMapRepinPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setPreview(null);
    setError(null);
    void (async () => {
      for (let attempt = 0; attempt < PREVIEW_ATTEMPTS && !abort.signal.aborted; attempt += 1) {
        const next = await studioHost.projects.previewMapRepin(documentId, { targetMapVersionId, waitMs: PREVIEW_WAIT_MS }, abort.signal);
        if (abort.signal.aborted) return;
        setPreview(next);
        if (!next.status || next.status.state === "succeeded" || next.status.state === "failed") return;
      }
    })().catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => abort.abort();
  }, [documentId, open, studioHost, targetMapVersionId]);

  const plan = preview?.plan ?? null;
  const box = useMemo(() => (plan ? extent(plan) : null), [plan]);
  const ordered = useMemo(
    () => (plan ? [...plan.placements].sort((a, b) => (a.status === b.status ? 0 : a.status === "kept" ? 1 : b.status === "kept" ? -1 : 0)) : []),
    [plan],
  );
  const counts = plan ? plan.placements.reduce<Record<string, number>>((out, placement) => ({ ...out, [placement.status]: (out[placement.status] ?? 0) + 1 }), {}) : {};
  const changedRoads = plan ? plan.roads.filter((road) => road.change !== "none").length : 0;
  const status = preview?.status ?? null;
  const chip = preview && status?.state === "succeeded" ? diffChip(preview.motionDiff, true) : null;
  const simulationFailed = status?.state === "failed" ? status.message ?? status.failureCode : null;
  const canMove = Boolean(plan?.content && !plan.blocking && status?.state === "succeeded");

  const move = async () => {
    setMoving(true);
    setError(null);
    try {
      await onMove(targetMapVersionId);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="xl" data-testid="map-transition-dialog">
        <DialogHeader>
          <DialogTitle>Move to the new map version</DialogTitle>
          <DialogDescription>
            {plan
              ? `${plan.source.name} · ${shortDate(plan.source.publishedAt)} → ${plan.target.name} · ${shortDate(plan.target.publishedAt)}. The scenario as it is now is saved as a version first, so you can go back.`
              : "Planning the move…"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!plan && !error ? <Spinner label="Planning the move" /> : null}
          {plan && box ? (
            <div {...stylex.props(styles.body)}>
              <div {...stylex.props(styles.summary)}>
                <Chip tone={plan.geometry === "same" ? "positive" : "warning"} data-testid="map-transition-geometry">
                  {plan.geometry === "same" ? "Same roads; only heights change" : "Road geometry changed"}
                </Chip>
                <span {...stylex.props(typography.meta)}>
                  {changedRoads} {changedRoads === 1 ? "road" : "roads"} changed nearby
                  {plan.roadsTruncated ? " (nearest shown)" : ""} · {counts.kept ?? 0} kept · {counts.moved ?? 0} moved
                  {(counts.flagged ?? 0) + (counts.unplaced ?? 0) > 0 ? ` · ${(counts.flagged ?? 0) + (counts.unplaced ?? 0)} to check` : ""}
                </span>
                {status && status.state !== "succeeded" && status.state !== "failed" ? <Spinner size="sm" label="Simulating on the new map" /> : null}
                {chip ? <Chip tone={chip.tone} title={chip.title} data-testid="map-transition-motion">Motion: {chip.text}</Chip> : null}
              </div>
              <div {...stylex.props(styles.panes)}>
                <div {...stylex.props(styles.pane)}>
                  <span {...stylex.props(typography.label)}>Before · {plan.source.name} · {shortDate(plan.source.publishedAt)}</span>
                  <Stage plan={plan} side="before" box={box} />
                </div>
                <div {...stylex.props(styles.pane)}>
                  <span {...stylex.props(typography.label)}>After · {plan.target.name} · {shortDate(plan.target.publishedAt)}</span>
                  <Stage plan={plan} side="after" box={box} />
                </div>
              </div>
              <div {...stylex.props(styles.legend)}>
                <span {...stylex.props(typography.meta)}><span {...stylex.props(art.swatchElevation)} /> Height changed</span>
                <span {...stylex.props(typography.meta)}><span {...stylex.props(art.swatchGeometry)} /> Road changed or added</span>
                <span {...stylex.props(typography.meta)}><span {...stylex.props(art.swatchRemoved)} /> Road removed</span>
              </div>
              {plan.blocking ? (
                <p {...stylex.props(typography.bodySm, styles.text)} role="alert" data-testid="map-transition-blocking">
                  This scenario can't move yet: {plan.blocking.message}
                </p>
              ) : null}
              {simulationFailed ? (
                <p {...stylex.props(typography.bodySm, styles.text)} role="alert">The moved scenario could not be simulated: {simulationFailed}</p>
              ) : null}
              <ul {...stylex.props(styles.placements)} aria-label="Where each actor starts on the new map">
                {ordered.map((placement) => <PlacementRow key={placement.roleId} placement={placement} />)}
              </ul>
            </div>
          ) : null}
          {error ? <p {...stylex.props(typography.bodySm, styles.text)} role="alert">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <div {...stylex.props(styles.actions)}>
            <Button onClick={onClose} size="sm" variant="ghost" data-testid="map-transition-stay">Stay on current</Button>
            <Button disabled={!canMove || moving} onClick={() => void move()} size="sm" variant="accent" data-testid="map-transition-move">
              {moving ? <Spinner size="sm" tone="onAccent" /> : null}
              Move to new map version
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
