"use client";

import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { styles } from "./shared.stylex";

const STATUS_BADGE_CLASS: Record<string, keyof typeof styles> = { queued: "queued", running: "running", complete: "complete", succeeded: "complete", promoted: "complete", registered: "queued", failed: "failed" };

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_BADGE_CLASS[status] ?? "queued";
  return <Badge variant="outline" xstyle={[styles.status, styles[tone]]}>{status}</Badge>;
}

export function formatScore(score: number | null | undefined): string {
  return typeof score === "number" ? `${(score * 100).toFixed(1)}%` : "—";
}

export function formatDelta(delta: number | null | undefined): string {
  if (typeof delta !== "number") return "—";
  const points = delta * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pts`;
}

export type FetchState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

export function useJsonFetch<T>(url: string | null, refreshKey = 0): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ kind: "loading" });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${response.status}`);
        }
        return (await response.json()) as T;
      })
      .then((data) => setState({ kind: "ready", data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [url, refreshKey]);
  return state;
}

export function PanelMessage({ children }: { children: React.ReactNode }) {
  return <div {...stylex.props(styles.message)}>{children}</div>;
}
