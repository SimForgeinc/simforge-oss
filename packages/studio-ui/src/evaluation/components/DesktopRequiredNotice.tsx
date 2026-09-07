"use client";

/**
 * What a retired web surface says.
 *
 * Maps, scenario authoring, render configuration and native playback are not
 * hidden behind a flag in the browser — the portal does not ship them, and it
 * does not fetch a map tile or a 3D asset to tell you so. A retired URL keeps
 * working and explains where the capability lives, so a bookmarked link is an
 * answer rather than a 404.
 */

import type { ReactNode } from "react";
import { ArrowRight, Monitor } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";

export function DesktopRequiredNotice({
  capability,
  description,
  bullets = [],
  downloadHref = "/download",
  downloadLabel = "Get the desktop app",
  secondaryAction,
  className,
}: {
  /** The capability the visitor was looking for, e.g. "The map catalogue". */
  capability: string;
  description: string;
  /** What the desktop app does with it, concretely. */
  bullets?: readonly string[];
  downloadHref?: string;
  downloadLabel?: string;
  secondaryAction?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "mx-auto flex max-w-2xl flex-col items-start gap-5 border border-border bg-muted/20 p-8",
        className,
      )}
      data-testid="desktop-required-notice"
    >
      <span className="inline-flex items-center gap-2 border border-border px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Monitor aria-hidden="true" className="size-3.5" />
        Desktop app
      </span>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {capability} runs in the SimForge desktop app
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>

      {bullets.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
          {bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      ) : null}

      <p className="text-sm leading-6 text-muted-foreground">
        The web portal keeps clip upload, cloud open-loop evaluation, results, and your account,
        team and billing. Everything that needs a map, a 3D viewport or native rendering is in the
        app — the same sign-in and the same workspace.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <a href={downloadHref}>
            {downloadLabel}
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
        {secondaryAction}
      </div>
    </section>
  );
}
