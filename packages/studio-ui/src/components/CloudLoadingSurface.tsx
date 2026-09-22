"use client";
import { useMemo, type CSSProperties, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { LoaderCircle } from "lucide-react";
import { SkyCloudBackdrop } from "./SkyCloudBackdrop";
import { mergeStyleProps } from "./stylex/surface";
import { styles } from "./CloudLoadingSurface.stylex";
import { useCloudLoadingSource, type CloudLoadingKind, type CloudLoadingSource } from "./cloud-loading-context";

/** One labelled figure on the telemetry plate, e.g. `{ label: "Speed", value: "4.8 MB/s" }`. */
export type CloudLoadingMetric = { label: string; value: string };
/**
 * The byte view of a load. `transferred` is what crossed the network this
 * time; `metrics` are the figures that explain what the loader is doing with
 * it (in flight, decoding, on the GPU, on screen), so "loaded" is never the
 * only word on the plate.
 */
export type CloudLoadingTelemetry = { transferred: string; total?: string | null; speed?: string | null; eta?: string | null; stalled?: boolean; stalledFor?: string | null; metrics?: ReadonlyArray<CloudLoadingMetric> };

/**
 * Studio's one loading design: the sky-cloud plate with a title, an optional
 * detail line, progress and download telemetry. Every loading
 * screen, pane and cover in the product is this component at one of three
 * scopes; `CloudActivityIndicator` below it is the inline affordance (a button
 * spinner), never a page or pane state.
 *
 * A `scope="screen"` surface under a `CloudLoadingHost` does not paint: it
 * publishes itself to the host, which keeps exactly one viewport cover across
 * a route-to-scene handoff. Its smoke is a local video, never another renderer. See
 * `cloud-loading-context.ts`.
 */
export type CloudLoadingSurfaceProps = {
  scope: "screen" | "pane" | "embedded";
  /** Which band a screen-scoped surface competes in when several are mounted. */
  kind?: CloudLoadingKind;
  /** Overrides the band `kind` implies; a deeper route segment outranks a shallower one. */
  priority?: number;
  title: string;
  detail?: string | null;
  progress?: number | null;
  progressValueLabel?: string;
  /** Cooperative liveness signal for long stages whose visible progress is coarse. */
  activityToken?: string | number;
  telemetry?: CloudLoadingTelemetry | null;
  /** The loading stage, published as `data-load-phase` for CSS and tests. */
  phase?: string;
  icon?: ReactNode;
  children?: ReactNode;
  diagnostics?: ReactNode;
  className?: string;
  xstyle?: stylex.StyleXStyles;
  style?: CSSProperties;
  /** The shared smoke animation; false uses its exact reduced-motion still. */
  backdropAnimated?: boolean;
  /** The desktop file shell supplies a relative directory for bundled assets. */
  backdropAssetBase?: string;
  backdropClassName?: string;
  contentWrapClassName?: string;
  contentClassName?: string;
  testId?: string;
  contentTestId?: string;
  telemetryTestId?: string;
  role?: "status" | "alert";
  ariaBusy?: boolean;
  ariaHidden?: boolean;
  dataTransitionState?: "covering" | "revealing";
};

export function CloudLoadingSurface({ scope, kind = "route", priority, title, detail, progress, progressValueLabel, activityToken, telemetry, phase, icon, children, diagnostics, className, xstyle, style, backdropAnimated = scope !== "pane", backdropAssetBase, backdropClassName, contentWrapClassName, contentClassName, testId = "cloud-loading-surface", contentTestId = "cloud-loading-content", telemetryTestId = "cloud-loading-telemetry", role = "status", ariaBusy = role !== "alert", ariaHidden = false, dataTransitionState }: CloudLoadingSurfaceProps) {
  // Memoized because the host compares sources field by field: a fresh `icon`
  // or `actions` element every render would republish on every render.
  const published = useMemo<CloudLoadingSource | null>(
    () => scope !== "screen" ? null : { kind, title, detail, progress, progressValueLabel, activityToken, telemetry, phase, priority, severity: role === "alert" ? "error" : "loading", icon, actions: children, diagnostics },
    [activityToken, children, diagnostics, detail, icon, kind, phase, priority, progress, progressValueLabel, role, scope, telemetry, title],
  );
  const hosted = useCloudLoadingSource(published);
  const normalizedProgress = normalizeProgress(progress); const hasProgress = progress !== undefined;
  if (hosted && scope === "screen") return null;
  return <div aria-busy={ariaBusy} aria-hidden={ariaHidden || undefined} aria-live={role === "alert" ? "assertive" : "polite"} {...mergeStyleProps(stylex.props(styles.root, scope === "screen" && styles.screen, scope === "pane" && styles.pane, scope === "embedded" && styles.embedded, xstyle), className, style)} data-cloud-loading-scope={scope} data-load-kind={kind} data-load-phase={phase} data-transition-state={dataTransitionState} data-testid={testId} role={role}>
    {scope !== "pane" ? <SkyCloudBackdrop animated={backdropAnimated} assetBase={backdropAssetBase} className={backdropClassName} /> : null}
    <div {...mergeStyleProps(stylex.props(styles.wrap, scope === "pane" && styles.paneWrap), contentWrapClassName)}><div {...mergeStyleProps(stylex.props(scope === "pane" ? styles.paneContent : styles.fullContent), contentClassName)} data-testid={contentTestId}>
      <div {...stylex.props(styles.row)}><div {...stylex.props(styles.icon)}>{icon ?? <LoaderCircle aria-hidden="true" {...stylex.props(styles.spin)} />}</div><div {...stylex.props(styles.body)}><h2 {...stylex.props(styles.title, scope === "pane" ? styles.titlePane : styles.titleFull)}>{title}</h2>{detail ? <p {...stylex.props(styles.detail)}>{detail}</p> : null}{telemetry ? <CloudLoadingTelemetryPanel telemetry={telemetry} testId={telemetryTestId} /> : null}{diagnostics != null ? <div {...stylex.props(styles.diagnostics)}>{diagnostics}</div> : null}</div></div>
      {hasProgress ? <div {...stylex.props(styles.progressWrap)}><div aria-label={`${title} progress`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={normalizedProgress ?? undefined} {...stylex.props(styles.progressTrack)} role="progressbar">{normalizedProgress == null ? <div {...stylex.props(styles.shimmer)} /> : <div {...stylex.props(styles.progressFill)} style={{ width: `${normalizedProgress}%` }} />}</div><div {...stylex.props(styles.progressMeta)}><span>{progressValueLabel ?? (normalizedProgress == null ? "Working" : `${normalizedProgress}%`)}</span></div></div> : null}
      {children}
    </div></div>
  </div>;
}
export function CloudActivityIndicator({ label, className, xstyle, iconXstyle, testId }: { label?: string; className?: string; xstyle?: stylex.StyleXStyles; iconXstyle?: stylex.StyleXStyles; testId?: string }) { return <span {...mergeStyleProps(stylex.props(styles.activity, xstyle), className)} data-testid={testId} role={label ? "status" : undefined}><LoaderCircle aria-hidden="true" {...stylex.props(styles.activityIcon, iconXstyle)} />{label ? <span>{label}</span> : null}</span>; }
function CloudLoadingTelemetryPanel({ telemetry, testId }: { telemetry: CloudLoadingTelemetry; testId: string }) {
  const headline = telemetry.total ? `${telemetry.transferred} of ${telemetry.total} downloaded` : `${telemetry.transferred} downloaded`;
  return <div {...stylex.props(styles.telemetry, telemetry.stalled && styles.telemetryStalled)} data-testid={testId}>
    <div {...stylex.props(styles.telemRow)}><span>{headline}</span>{telemetry.speed ? <span>{telemetry.speed}</span> : null}</div>
    {telemetry.metrics && telemetry.metrics.length > 0 ? <dl {...stylex.props(styles.telemGrid)}>{telemetry.metrics.map((metric) => <div key={metric.label} {...stylex.props(styles.telemMetric)}><dt {...stylex.props(styles.telemLabel)}>{metric.label}</dt><dd {...stylex.props(styles.telemValue)}>{metric.value}</dd></div>)}</dl> : null}
    {telemetry.eta ? <p {...stylex.props(styles.telemText)}>{telemetry.eta} remaining</p> : null}
    {telemetry.stalled ? <p {...stylex.props(styles.telemWarn)}>No data received for {telemetry.stalledFor ?? "several seconds"}</p> : null}
  </div>;
}
function normalizeProgress(progress: number | null | undefined) { if (progress == null || !Number.isFinite(progress)) return null; return Math.max(0, Math.min(100, Math.round(progress))); }
