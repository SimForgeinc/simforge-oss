"use client";

import { Cloud, CloudOff, ShieldAlert } from "lucide-react";
import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@simforge-oss/studio-ui/components/ui/sheet";
import type { XStyle } from "@simforge-oss/studio-ui/components/stylex";
import { card, chip, cloud, lamp, action } from "@/app/components/host-status-cards.stylex";
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

function accountLabel(status: StudioCloudStatus): string {
  return status.user?.name ?? status.user?.email ?? "SimCloud account";
}

/** What the current state means for this app, in product terms — never a token or code. */
function cloudStateExplanation(status: StudioCloudStatus | null): string {
  if (!status) return "Checking the SimCloud connection…";
  switch (status.state) {
    case "disconnected":
      return "SimForge works on this computer without an account. Richmond Field Station is always available; sign in to download other published maps and use cloud storage.";
    case "connecting":
      return "Google and GitHub sign in through your browser. Studio updates itself as soon as the browser comes back; nothing here reloads.";
    case "connected":
      return status.credentialPersistence === "session"
        ? "This computer has no secure credential vault, so the sign-in lasts only until the app closes. Sign in again after restarting."
        : "Sign-in is kept in this computer's secure vault. Your projects stay local; nothing is uploaded unless you publish it.";
    case "expired":
      return "Maps that need an account and cloud storage are locked until you sign in again. Local projects, renders and documents are untouched.";
    case "error":
      return status.message ?? "SimCloud reported a problem with this connection.";
  }
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The SimCloud account on the Settings page: connection facts above the
 * inline account panel. Signed out, the panel is the sign-in form; signed in,
 * it is the account with sign-out (which always asks first, because it locks
 * account-only maps).
 */
export function CloudAccountCard({ xstyle }: { xstyle?: stylex.StyleXStyles }) {
  const { status } = useStudioCloudStatus();
  const state = status?.state ?? null;
  const expiry = formatExpiry(status?.sessionExpiresAt ?? null);

  return (
    <section
      aria-labelledby="cloud-account-title"
      {...stylex.props(card.section, xstyle)}
      data-testid="cloud-account-card"
      data-cloud-state={state ?? "loading"}
    >
      <div {...stylex.props(card.header)}>
        <div {...stylex.props(card.icon)}>
          {state === "connected" ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
        </div>
        <div {...stylex.props(card.body)}>
          <p {...stylex.props(card.eyebrow)}>SimCloud account</p>
          <h2 id="cloud-account-title" {...stylex.props(card.title, card.titleRow)}>
            <span aria-hidden="true" {...stylex.props(lamp.base, stateLampStyle(state))} />
            <span {...stylex.props(card.truncate)}>
              {status?.state === "connected" ? accountLabel(status) : state ? CLOUD_STATE_LABELS[state] : "Checking…"}
            </span>
          </h2>
          {status?.state === "connected" && status.user?.email ? (
            <p {...stylex.props(card.truncate, cloud.email)}>{status.user.email}</p>
          ) : null}
          <p {...stylex.props(card.lede)} role={state === "error" ? "alert" : undefined}>
            {cloudStateExplanation(status)}
          </p>
          {status ? (
            <dl {...stylex.props(cloud.facts)}>
              <div {...stylex.props(cloud.fact)}>
                <dt {...stylex.props(card.factLabel)}>Server</dt>
                <dd {...stylex.props(card.truncate, card.mono)} title={status.origin}>{status.origin.replace(/^https?:\/\//, "")}</dd>
              </div>
              {status.state === "connected" ? (
                <div {...stylex.props(cloud.fact)}>
                  <dt {...stylex.props(card.factLabel)}>Credentials</dt>
                  <dd>{status.credentialPersistence === "os-vault" ? "Secure vault on this computer" : "This app session only"}</dd>
                </div>
              ) : null}
              {status.state === "connected" && expiry ? (
                <div {...stylex.props(cloud.fact)}>
                  <dt {...stylex.props(card.factLabel)}>Session until</dt>
                  <dd>{expiry}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {status?.state === "connected" && status.credentialPersistence === "session" ? (
            <p {...stylex.props(cloud.sessionNotice)}>
              <ShieldAlert className={stylex.props(cloud.sessionNoticeIcon).className} aria-hidden="true" />
              No OS credential vault was available; the sign-in is held in memory only and is discarded when the app closes.
            </p>
          ) : null}
        </div>
      </div>

      <div {...stylex.props(card.actions)}>
        <CloudAccountPanel />
        {status?.state === "connected" ? (
          <Button asChild xstyle={action.accent}>
            <Link href="/dashboard/cloud-storage">
              <Cloud {...stylex.props(action.icon)} aria-hidden="true" />
              Open cloud storage
            </Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One-line account summary for the app switcher. Signed out, its action
 * opens the account sheet in place — the switcher never launches anything.
 */
export function CloudAccountChip({ onNavigate }: { onNavigate?: () => void }) {
  const { status, error, openAccountPanel } = useStudioCloudStatus();
  const state = status?.state ?? null;
  const summary =
    status?.state === "connected"
      ? status.user?.email ?? accountLabel(status)
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
      {state === "connected" ? (
        <Link {...stylex.props(chip.action, chip.manage)} href="/dashboard/account" onClick={onNavigate}>
          Manage
        </Link>
      ) : (
        <button
          {...stylex.props(chip.action, chip.connect)}
          disabled={status === null}
          onClick={() => {
            onNavigate?.();
            openAccountPanel();
          }}
          type="button"
        >
          {state === "connecting" ? "Show" : state === "expired" ? "Sign in again" : "Sign in"}
        </button>
      )}
    </div>
  );
}

/**
 * The account sheet, mounted once under the connector so any surface
 * (switcher chip, locked map, cloud storage, onboarding) can ask for the
 * sign-in form in place instead of navigating to Settings.
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
