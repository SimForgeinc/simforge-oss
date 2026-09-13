"use client";

import { Cloud, CloudOff, ExternalLink, LoaderCircle, LogOut, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { mergeStyleProps, type XStyle } from "@simforge-oss/studio-ui/components/stylex";
import { card, chip, cloud, lamp, action } from "@/app/components/host-status-cards.stylex";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

const CLOUD_STATE_LABELS: Record<StudioCloudStatus["state"], string> = {
  disconnected: "Not connected",
  connecting: "Waiting for your browser",
  connected: "Connected",
  expired: "Session expired",
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
function cloudStateExplanation(status: StudioCloudStatus | null, error: string | null): string {
  if (error) return error;
  if (!status) return "Checking the SimCloud connection…";
  switch (status.state) {
    case "disconnected":
      return "SimForge works on this computer without an account. Richmond Field Station is always available; connect to download other published maps and use cloud storage.";
    case "connecting":
      return "Approve this computer in the browser tab that just opened. The app updates itself once SimCloud confirms; nothing here reloads.";
    case "connected":
      return status.credentialPersistence === "session"
        ? "This computer has no secure credential vault, so the sign-in lasts only until the app closes. Connect again after restarting."
        : "Sign-in is kept in this computer's secure vault. Your projects stay local; nothing is uploaded unless you publish it.";
    case "expired":
      return "Your SimCloud session ended. Maps that need an account and cloud storage are locked until you connect again. Local projects, renders and documents are untouched.";
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
 * Connection controls for the optional SimCloud account. Connect opens the
 * consent page in the system browser and the card follows the local service's
 * status; Disconnect always asks first because it locks account-only maps.
 *
 * Button variants are StyleX-backed; explicit caller classes remain where the
 * control needs a card-specific size or presentation override.
 */
export function CloudConnectionCard({ xstyle }: { xstyle?: stylex.StyleXStyles }) {
  const { status, loading, error, connect, disconnect } = useStudioCloudStatus();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const state = status?.state ?? null;
  const expiry = formatExpiry(status?.sessionExpiresAt ?? null);

  return (
    <section
      aria-labelledby="cloud-connection-title"
      {...stylex.props(card.section, xstyle)}
      data-testid="cloud-connection-card"
      data-cloud-state={state ?? "loading"}
    >
      <div {...stylex.props(card.header)}>
        <div {...stylex.props(card.icon)}>
          {state === "connected" ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
        </div>
        <div {...stylex.props(card.body)}>
          <p {...stylex.props(card.eyebrow)}>SimCloud account</p>
          <h2 id="cloud-connection-title" {...stylex.props(card.title, card.titleRow)}>
            <span aria-hidden="true" {...stylex.props(lamp.base, stateLampStyle(state))} />
            <span {...stylex.props(card.truncate)}>
              {status?.state === "connected" ? accountLabel(status) : state ? CLOUD_STATE_LABELS[state] : "Checking…"}
            </span>
          </h2>
          {status?.state === "connected" && status.user?.email ? (
            <p {...stylex.props(card.truncate, cloud.email)}>{status.user.email}</p>
          ) : null}
          <p {...stylex.props(card.lede)} role={error || state === "error" ? "alert" : undefined}>
            {cloudStateExplanation(status, error)}
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
        {state === "connecting" ? (
          <>
            <Button xstyle={action.accent} disabled>
              <LoaderCircle {...stylex.props(action.icon, action.spin)} aria-hidden="true" />
              Waiting for approval
            </Button>
            <Button
              xstyle={action.outline}
              onClick={() => void disconnect()}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
          </>
        ) : state === "connected" ? (
          confirmDisconnect ? (
            <div
              {...stylex.props(cloud.confirm)}
              role="alertdialog"
              aria-labelledby="cloud-disconnect-title"
              aria-describedby="cloud-disconnect-detail"
            >
              <p id="cloud-disconnect-title" {...stylex.props(cloud.confirmTitle)}>Disconnect from SimCloud?</p>
              <p id="cloud-disconnect-detail" {...stylex.props(cloud.confirmDetail)}>
                Maps that need an account and cloud storage lock until you connect again. Local projects, renders and
                documents on this computer are kept.
              </p>
              <div {...stylex.props(cloud.confirmActions)}>
                <Button
                  xstyle={action.amber}
                  disabled={loading}
                  onClick={() => {
                    setConfirmDisconnect(false);
                    void disconnect();
                  }}
                  type="button"
                >
                  <LogOut {...stylex.props(action.icon)} aria-hidden="true" />
                  Disconnect
                </Button>
                <Button
                  autoFocus
                  xstyle={action.outline}
                  onClick={() => setConfirmDisconnect(false)}
                  type="button"
                  variant="outline"
                >
                  Keep connection
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Button asChild xstyle={action.accent}>
                <Link href="/dashboard/cloud-storage">
                  <Cloud {...stylex.props(action.icon)} aria-hidden="true" />
                  Open cloud storage
                </Link>
              </Button>
              <Button
                xstyle={action.outline}
                disabled={loading}
                onClick={() => setConfirmDisconnect(true)}
                type="button"
                variant="outline"
              >
                <LogOut {...stylex.props(action.icon)} aria-hidden="true" />
                Disconnect
              </Button>
            </>
          )
        ) : (
          <Button
            xstyle={action.accentConnect}
            disabled={loading || status === null}
            onClick={() => void connect()}
            type="button"
          >
            {loading ? (
              <LoaderCircle {...stylex.props(action.icon, action.spin)} aria-hidden="true" />
            ) : (
              <ExternalLink {...stylex.props(action.icon)} aria-hidden="true" />
            )}
            {state === "expired" || state === "error" ? "Connect again" : "Connect to SimCloud"}
          </Button>
        )}
      </div>
    </section>
  );
}

/** One-line connection summary with the single most useful action, for the app switcher. */
export function CloudConnectionChip({ onNavigate }: { onNavigate?: () => void }) {
  const { status, loading, error, connect } = useStudioCloudStatus();
  const state = status?.state ?? null;
  const summary =
    status?.state === "connected"
      ? status.user?.email ?? accountLabel(status)
      : error ?? (state ? CLOUD_STATE_LABELS[state] : "Checking…");

  return (
    <div
      {...stylex.props(chip.root)}
      data-testid="cloud-connection-chip"
      data-cloud-state={state ?? "loading"}
    >
      <span aria-hidden="true" {...stylex.props(lamp.base, stateLampStyle(state))} />
      <div {...stylex.props(chip.body)}>
        <p {...stylex.props(chip.eyebrow)}>SimCloud</p>
        <p {...stylex.props(card.truncate, chip.summary)} title={summary}>
          {summary}
        </p>
      </div>
      {state === "connected" || state === "connecting" ? (
        <Link
          {...stylex.props(chip.action, chip.manage)}
          href="/dashboard/settings"
          onClick={onNavigate}
        >
          Manage
        </Link>
      ) : (
        <button
          {...stylex.props(chip.action, chip.connect)}
          disabled={loading || status === null}
          onClick={() => void connect()}
          type="button"
        >
          {state === "expired" || state === "error" ? "Connect again" : "Connect"}
        </button>
      )}
    </div>
  );
}
