"use client";

import { useMemo } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  dashboardRouteLoadingSource,
  useDashboardLoadingSource,
} from "../DashboardLoadingCoordinator";
import { styles } from "./sim-loader.stylex";
export function RouteLoading({
  label,
  detail = "Loading…",
  depth = 1,
}: {
  label: string;
  detail?: string;
  depth?: number;
}) {
  const source = useMemo(
    () => dashboardRouteLoadingSource({ label, detail, depth }),
    [depth, detail, label],
  );
  useDashboardLoadingSource(source);
  return (
    <span aria-hidden="true" data-testid="route-loading-marker">
      <span {...stylex.props(styles.srOnly)}>Loading {label}</span>
    </span>
  );
}
