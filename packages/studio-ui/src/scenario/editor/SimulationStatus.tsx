"use client";

import * as stylex from "@stylexjs/stylex";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type { SimulationVerificationState } from "../../lib/scenario/playback/authoritativeSimulation";
import { colors, space, text } from "../../stylex/tokens.stylex";

function shortDigest(value: string | null): string {
  return value ? value.slice(0, 12) : "none";
}

/**
 * Where the editor's preview stands against the host's authoritative
 * simulation. "Local preview" is the editor's own instant run; "Verified"
 * means the authoritative trace for the same saved content has the same
 * digest. A mismatch means the authoritative trace is on screen instead and
 * the difference was reported as a determinism bug.
 */
export function SimulationStatus({ verification, onRetry }: {
  verification?: SimulationVerificationState;
  onRetry?: () => void;
}) {
  if (!verification) return null;
  const { label, title, variant } = describe(verification);
  return (
    <div {...stylex.props(styles.line)} data-simulation-status={verification.status} role="status">
      <Badge title={title} variant={variant}>{label}</Badge>
      {verification.status === "unavailable" && onRetry
        ? <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>
        : null}
    </div>
  );
}

function describe(verification: SimulationVerificationState): {
  label: string;
  title: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (verification.status) {
    case "local":
      return {
        label: "Local preview",
        title: verification.detail
          ? `Local preview (${verification.detail}). The authoritative simulation runs once the draft is saved.`
          : "Local preview: the editor's own simulation of this draft.",
        variant: "secondary",
      };
    case "verifying":
      return {
        label: "Local preview · verifying",
        title: verification.queued
          ? "The authoritative simulation of this draft is queued on a simulation worker."
          : "Fetching the authoritative simulation of this draft.",
        variant: "secondary",
      };
    case "verified":
      return {
        label: "Verified",
        title: `The authoritative simulation (engine ${verification.engineSemVer}, trace ${shortDigest(verification.traceSha256)}) matches this preview exactly.`,
        variant: "outline",
      };
    case "mismatch":
      return {
        label: verification.showingAuthoritative ? "Authoritative trace · preview differed" : "Preview differs",
        title: `The local preview (trace ${shortDigest(verification.localTraceSha256)}) differs from the authoritative simulation (trace ${shortDigest(verification.authoritativeTraceSha256)}). The authoritative trace is what renders and evaluations replay; the difference was reported.`,
        variant: "destructive",
      };
    case "unavailable":
      return {
        label: "Local preview · not verified",
        title: `The authoritative simulation is unavailable: ${verification.message}`,
        variant: "secondary",
      };
  }
}

const styles = stylex.create({
  line: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    color: colors.mutedForeground,
    fontSize: text.sizeXs,
    flexShrink: 0,
  },
});
