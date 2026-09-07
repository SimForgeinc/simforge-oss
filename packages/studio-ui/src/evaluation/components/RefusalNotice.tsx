"use client";

/**
 * The explanatory refusal.
 *
 * Whenever a run cannot happen — missing driving inputs, an unqualified model
 * profile, an unaffordable job — the user gets the reasons, in full sentences,
 * instead of a disabled button with no explanation or a run that silently
 * invents the missing data. Every string shown here comes from the classifier,
 * the runtime probe or the server; this component does not compose verdicts.
 */

import type { ReactNode } from "react";
import { AlertTriangle, Ban, Info } from "lucide-react";
import { cn } from "../../lib/utils";
import { DRIVING_REQUIREMENT_LABELS, type DrivingInputRequirement } from "../input-kinds";

const TONE_STYLES = {
  refusal: {
    container: "border-destructive/40 bg-destructive/10 text-foreground",
    icon: "text-destructive",
  },
  warn: {
    container: "border-amber-500/40 bg-amber-500/10 text-foreground",
    icon: "text-amber-500",
  },
  info: {
    container: "border-border bg-muted/30 text-foreground",
    icon: "text-muted-foreground",
  },
} as const;

export function RefusalNotice({
  tone = "refusal",
  title,
  reasons = [],
  missing = [],
  missingFieldPaths = [],
  children,
  action,
  className,
}: {
  tone?: keyof typeof TONE_STYLES;
  title: string;
  reasons?: readonly string[];
  /** Driving inputs the local classifier found absent. */
  missing?: readonly DrivingInputRequirement[];
  /**
   * Field paths from a worker refusal (`refusal.missingFields`), rendered
   * verbatim: they name positions in the input document, and paraphrasing them
   * would make the user's fix harder to find.
   */
  missingFieldPaths?: readonly string[];
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const styles = TONE_STYLES[tone];
  const Icon = tone === "refusal" ? Ban : tone === "warn" ? AlertTriangle : Info;

  return (
    <div
      role={tone === "info" ? undefined : "alert"}
      className={cn("border p-4", styles.container, className)}
      data-testid="refusal-notice"
    >
      <div className="flex gap-3">
        <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", styles.icon)} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-semibold">{title}</p>
          {reasons.length > 0 ? (
            <ul className="space-y-1 text-sm leading-6 text-muted-foreground">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {missing.length > 0 ? (
            <div className="text-sm leading-6 text-muted-foreground">
              <p>This input is missing:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {missing.map((requirement) => (
                  <li key={requirement}>{DRIVING_REQUIREMENT_LABELS[requirement]}</li>
                ))}
              </ul>
              <p className="mt-2">
                Nothing is substituted for missing driving inputs — a fabricated camera view, ego
                pose or label would make the numbers meaningless.
              </p>
            </div>
          ) : null}
          {missingFieldPaths.length > 0 ? (
            <div className="text-sm leading-6 text-muted-foreground">
              <p>The run reported these fields missing from the input:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
                {missingFieldPaths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {children}
          {action ? <div className="pt-1">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
