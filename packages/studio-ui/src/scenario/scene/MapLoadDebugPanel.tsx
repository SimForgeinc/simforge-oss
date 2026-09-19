"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CityViewer } from "@simforge-oss/viewer";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../../components/ui/button";
import { styles } from "./MapLoadDebugPanel.stylex";

const STORAGE_KEY = "simforge.map-load-debug.expanded";

export type MapLoadDebugSource = {
  getViewer: () => CityViewer | null;
  mapId?: string | null;
  mapVersionId?: string | null;
  installedMaps?: ReadonlyArray<{ sourceMapId: string; mapVersionId: string }>;
  manifestUrl?: string | null;
  requestedTier: string;
  phase: string;
  readinessAnnounced: boolean;
  error: unknown;
};

/** Error.message/stack/cause are non-enumerable; JSON.stringify(error) loses them. */
export function serializeLoadError(error: unknown, seen = new Set<unknown>()): unknown {
  if (error == null) return null;
  if (typeof error !== "object") return { message: String(error) };
  if (seen.has(error)) return { message: "[circular error cause]" };
  seen.add(error);
  const record = error as Record<string, unknown>;
  return {
    ...Object.fromEntries(Object.entries(record).filter(([key, value]) => key !== "cause" && key !== "errors" && (value == null || ["string", "number", "boolean"].includes(typeof value)))),
    name: typeof record.name === "string" ? record.name : "unknown",
    message: typeof record.message === "string" ? record.message : "unknown",
    ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
    ...(record.cause != null ? { cause: serializeLoadError(record.cause, seen) } : {}),
    ...(Array.isArray(record.errors) ? { errors: record.errors.map((entry) => serializeLoadError(entry, seen)) } : {}),
  };
}

function canvasPresentation(viewer: CityViewer) {
  const canvas = viewer.renderer.domElement;
  const bounds = canvas.getBoundingClientRect();
  let visible = canvas.isConnected && bounds.width > 0 && bounds.height > 0;
  for (let node: HTMLElement | null = canvas; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) visible = false;
  }
  return { visible, connected: canvas.isConnected, width: bounds.width, height: bounds.height, documentVisibility: document.visibilityState };
}

export function MapLoadDebugPanel({ source }: { source: MapLoadDebugSource }) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    try { setExpanded(localStorage.getItem(STORAGE_KEY) === "true"); } catch { /* Storage can be disabled. */ }
  }, []);
  useEffect(() => {
    const capture = () => {
      const current = sourceRef.current;
      const viewer = current.getViewer();
      if (!viewer) {
        setSnapshot((previous) => previous?.manifestUrlAtCapture === current.manifestUrl
          ? { ...previous, viewerAvailable: false }
          : { viewerAvailable: false, capturedAt: null });
        return;
      }
      try {
        const stats = viewer?.getStats();
        setSnapshot({
          capturedAt: new Date().toISOString(),
          manifestUrlAtCapture: current.manifestUrl ?? "unknown",
          viewerAvailable: true,
          tierSelection: stats?.tierSelection ?? "unknown",
          memory: stats ? { byteBudget: stats.byteBudget, residentBytes: stats.residentBytes, pendingBytes: stats.pendingBytes } : "unknown",
          progress: stats ? { residentTiles: stats.residentTiles, residentAssets: stats.residentAssets, coverage: stats.coverage, loading: stats.loading, queued: stats.queued, uploading: stats.uploading, pendingTextureUploads: stats.pendingTextureUploads, requiredPendingAssets: stats.requiredPendingAssets, usable: stats.usable, targetQualityReady: stats.targetQualityReady, loadProgress: stats.loadProgress, downloads: stats.downloads } : "unknown",
          renderConfiguration: viewer?.getRenderConfiguration() ?? "unknown",
          viewerDiagnostics: stats?.loadDiagnostics ?? "unknown",
          canvas: viewer ? canvasPresentation(viewer) : "unknown",
          errors: { streaming: stats?.streamingError ?? null, required: stats?.requiredError ?? null, detail: stats?.detailError ?? null, detailFailures: stats?.detailFailures ?? "unknown" },
        });
      } catch (error) {
        setSnapshot((previous) => ({ ...previous, captureError: serializeLoadError(error) }));
      }
    };
    capture();
    const timer = window.setInterval(capture, 500);
    return () => window.clearInterval(timer);
  }, [source.manifestUrl, source.phase, source.error]);
  const payload = {
    schema: "simforge.map-load-debug.v1",
    identity: { mapId: source.mapId ?? "unknown", mapVersionId: source.mapVersionId ?? "unknown", manifestUrl: source.manifestUrl ?? "unknown" },
    installedMaps: source.installedMaps ?? "unknown",
    environment: { userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent, pageUrl: typeof location === "undefined" ? "unknown" : `${location.origin}${location.pathname}` },
    requestedTier: source.requestedTier,
    phase: source.phase,
    readinessAnnounced: source.readinessAnnounced,
    loadError: serializeLoadError(source.error),
    ...snapshot,
  };
  const json = JSON.stringify(payload, null, 2);
  return <aside {...stylex.props(styles.panel)} aria-label="Map loading diagnostics" aria-live="off" data-testid="map-load-debug">
    <button {...stylex.props(styles.toggle)} type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => {
      const next = !expanded;
      setExpanded(next);
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* The panel still works without persistence. */ }
    }}>{expanded ? "▾" : "▸"} ADVANCED / DEBUG</button>
    {expanded ? <div id={contentId} {...stylex.props(styles.content)}>
      <div {...stylex.props(styles.toolbar)}><span>Live map diagnostics · sizes in bytes</span><Button size="sm" onClick={async () => {
        try { await navigator.clipboard.writeText(json); setCopyStatus("Copied JSON"); }
        catch { setCopyStatus("Clipboard unavailable. Select and copy the JSON below."); }
      }}>Copy JSON</Button></div>
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
      <pre {...stylex.props(styles.json)} tabIndex={0} data-testid="map-load-debug-json">{json}</pre>
    </div> : null}
  </aside>;
}
