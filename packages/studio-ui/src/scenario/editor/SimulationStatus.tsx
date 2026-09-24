"use client";

import * as stylex from "@stylexjs/stylex";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type { SimulationVerificationState } from "../../lib/scenario/playback/authoritativeSimulation";
import { textLayout } from "../../stylex/recipes.stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";
import { humanizeCode } from "./render/render-view-model";

function shortDigest(value: string | null): string {
  return value ? value.slice(0, 12) : "none";
}

/**
 * Where the editor's preview stands against the host's authoritative
 * simulation. "Local preview" is the editor's own instant run; "Verified"
 * means the authoritative trace for the same saved content has the same
 * digest. A mismatch means the authoritative trace is on screen instead and
 * the difference was reported as a determinism bug. A failed simulation shows
 * its reason and, while the host still allows it, a Retry that runs it again.
 */
export function SimulationStatus({ verification, onRetry }: {
  verification?: SimulationVerificationState;
  onRetry?: () => void;
}) {
  if (!verification) return null;
  const { label, title, variant } = describe(verification);
  const reason = verification.status === "failed" ? failureReason(verification) : null;
  // A failed simulation with no retries left is not offered one: it runs again when the engine or
  // release changes. A host that predates explicit retries (null) gets the plain re-check.
  const retryable = verification.status === "unavailable"
    || (verification.status === "failed" && verification.retriesRemaining !== 0);
  return (
    <div {...stylex.props(styles.line)} data-simulation-status={verification.status} role="status">
      <Badge title={title} variant={variant}>{label}</Badge>
      {reason
        ? <span {...stylex.props(textLayout.truncate, styles.reason)} data-testid="simulation-failure-reason" title={title}>{reason}</span>
        : null}
      {retryable && onRetry
        ? <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>
        : null}
    </div>
  );
}

/** Why the host's simulation failed: its message, else its humanized failure code. */
export function failureReason(verification: { failureCode: string; message: string | null }): string {
  const message = verification.message?.trim();
  return message ? message : humanizeCode(verification.failureCode);
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
    case "failed":
      return {
        label: "Simulation failed",
        title: `The authoritative simulation of this draft failed: ${failureReason(verification)}.${
          verification.retriesRemaining === 0
            ? " The retry limit is reached; it runs again when the engine or release changes."
            : verification.retriesRemaining === null
              ? ""
              : ` Retry runs it again (${verification.retriesRemaining} left).`
        }`,
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
  // The reason sits in the toolbar: one line, no wider than an inspector (full text in its title).
  reason: {
    minWidth: 0,
    maxWidth: space.inspectorWidth,
  },
});
