"use client";

import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@simforge-oss/studio-ui/components/ui/sheet";
import type { XStyle } from "@simforge-oss/studio-ui/components/stylex";
import { card, chip, lamp } from "@/app/components/host-status-cards.stylex";
import { CloudAccountPanel } from "@/app/components/cloud/CloudAccountPanel";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

const CLOUD_STATE_LABELS: Record<StudioCloudStatus["state"], string> = {
  disconnected: "Signed out",
  connecting: "Finishing in your browser",
  connected: "Signed in",
  expired: "Session ended",
  error: "Connection problem",
};

/** The lamp variant for a connection state. Expired and errored share one. */
function stateLampStyle(state: StudioCloudStatus["state"] | null): XStyle {
  switch (state) {
    case "connected":
      return lamp.connected;
    case "connecting":
      return lamp.connecting;
    case "expired":
    case "error":
      return lamp.attention;
    default:
      return lamp.idle;
  }
}

/**
 * One-line account summary for the app switcher, and the one link to the
 * SimCloud surface. Signed in or out, the action goes to the same place:
 * `/dashboard/simcloud` is where every account flow lives.
 */
export function CloudAccountChip({ onNavigate }: { onNavigate?: () => void }) {
  const { status, error } = useStudioCloudStatus();
  const state = status?.state ?? null;
  const summary =
    status?.state === "connected"
      ? status.user?.email ?? status.user?.name ?? "SimCloud account"
      : error ?? (state ? CLOUD_STATE_LABELS[state] : "Checking…");

  return (
    <div
      {...stylex.props(chip.root)}
      data-testid="cloud-account-chip"
      data-cloud-state={state ?? "loading"}
    >
      <span aria-hidden="true" {...stylex.props(lamp.base, stateLampStyle(state))} />
      <div {...stylex.props(chip.body)}>
        <p {...stylex.props(chip.eyebrow)}>SimCloud</p>
        <p {...stylex.props(card.truncate, chip.summary)} title={summary}>
          {summary}
        </p>
      </div>
      <Link
        {...stylex.props(chip.action, state === "connected" ? chip.manage : chip.connect)}
        href="/dashboard/simcloud"
        onClick={onNavigate}
      >
        {state === "connected" ? "Manage" : state === "expired" ? "Sign in again" : "Sign in"}
      </Link>
    </div>
  );
}

/**
 * The account sheet for onboarding, which runs before the dashboard (and so
 * before `/dashboard/simcloud`) is reachable. Mounted once under the
 * connector so the first-run screens can ask for the sign-in form in place.
 */
export function CloudAccountSheet() {
  const { accountPanelOpen, closeAccountPanel } = useStudioCloudStatus();
  return (
    <Sheet open={accountPanelOpen} onOpenChange={(open) => { if (!open) closeAccountPanel(); }}>
      <SheetContent side="right" data-testid="cloud-account-sheet">
        <SheetHeader>
          <SheetTitle>SimCloud account</SheetTitle>
          <SheetDescription>
            Sign in for your account&apos;s maps and cloud storage. Everything on this computer keeps working without one.
          </SheetDescription>
        </SheetHeader>
        <CloudAccountPanel onSignedIn={closeAccountPanel} />
      </SheetContent>
    </Sheet>
  );
}
