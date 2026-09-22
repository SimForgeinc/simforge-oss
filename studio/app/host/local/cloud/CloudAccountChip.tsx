"use client";

import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown, UserRound } from "lucide-react";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@simforge-oss/studio-ui/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import type { XStyle } from "@simforge-oss/studio-ui/components/stylex";
import { card, chip, lamp } from "@/app/components/host-status-cards.stylex";
import { CloudAccountPanel } from "./CloudAccountPanel";
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
 * The SimCloud connection as one segment of the switcher's bar: who you are
 * (or the connection's state) is the button, and its menu holds the one link
 * to the SimCloud surface. Signed in or out, that link goes to the same
 * place: `/dashboard/simcloud` is where every account flow lives.
 */
export function CloudAccountChip({ onNavigate }: { onNavigate?: () => void }) {
  const { status, error } = useStudioCloudStatus();
  const state = status?.state ?? null;
  const connected = status?.state === "connected";
  const summary = connected
    ? status.user?.name ?? status.user?.email ?? "SimCloud account"
    : error ?? (state ? CLOUD_STATE_LABELS[state] : "Checking…");
  const detail = connected ? status.user?.email ?? CLOUD_STATE_LABELS.connected : "Not signed in to SimCloud";
  const action = connected ? "Manage account" : state === "expired" ? "Sign in again" : "Sign in";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          {...stylex.props(chip.root, chip.trigger)}
          aria-label={`SimCloud: ${summary}. Open account menu`}
          data-testid="cloud-account-chip"
          data-cloud-state={state ?? "loading"}
          type="button"
        >
          <span aria-hidden="true" {...stylex.props(lamp.base, stateLampStyle(state))} />
          <span {...stylex.props(chip.body)}>
            <span {...stylex.props(chip.eyebrow)}>SimCloud</span>
            <span {...stylex.props(card.truncate, chip.summary)} title={summary}>
              {summary}
            </span>
          </span>
          <ChevronDown {...stylex.props(chip.chevron)} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" xstyle={chip.menu} data-testid="account-menu">
        <DropdownMenuLabel>
          <span {...stylex.props(chip.menuName)}>{summary}</span>
          <span {...stylex.props(chip.menuMeta)}>{detail}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard/simcloud" onClick={onNavigate}>
            <UserRound {...stylex.props(chip.menuIcon)} aria-hidden="true" />
            {action}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
