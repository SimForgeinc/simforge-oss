"use client";

import { Cloud, CloudOff, ExternalLink, LoaderCircle, LogOut, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

const CLOUD_STATE_LABELS: Record<StudioCloudStatus["state"], string> = {
  disconnected: "Not connected",
  connecting: "Waiting for your browser",
  connected: "Connected",
  expired: "Session expired",
  error: "Connection problem",
};

function stateDotClass(state: StudioCloudStatus["state"] | null): string {
  switch (state) {
    case "connected":
      return "bg-[#E8E044] shadow-[0_0_14px_rgba(232,224,68,0.35)]";
    case "connecting":
      return "bg-sky-300 animate-pulse";
    case "expired":
    case "error":
      return "bg-amber-400";
    default:
      return "bg-white/25";
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
 */
export function CloudConnectionCard({ className }: { className?: string }) {
  const { status, loading, error, connect, disconnect } = useStudioCloudStatus();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const state = status?.state ?? null;
  const expiry = formatExpiry(status?.sessionExpiresAt ?? null);

  return (
    <section
      aria-labelledby="cloud-connection-title"
      className={cn("text-white", className)}
      data-testid="cloud-connection-card"
      data-cloud-state={state ?? "loading"}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center text-[#E8E044]">
          {state === "connected" ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">
            SimCloud account
          </p>
          <h2 id="cloud-connection-title" className="mt-1 flex items-center gap-2 text-lg font-semibold">
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-sm", stateDotClass(state))} />
            <span className="truncate">
              {status?.state === "connected" ? accountLabel(status) : state ? CLOUD_STATE_LABELS[state] : "Checking…"}
            </span>
          </h2>
          {status?.state === "connected" && status.user?.email ? (
            <p className="truncate font-mono text-xs text-white/55">{status.user.email}</p>
          ) : null}
          <p className="mt-2 text-sm leading-6 text-white/55" role={error || state === "error" ? "alert" : undefined}>
            {cloudStateExplanation(status, error)}
          </p>
          {status ? (
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-[11px] text-white/40 sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="shrink-0 font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">Server</dt>
                <dd className="truncate font-mono" title={status.origin}>{status.origin.replace(/^https?:\/\//, "")}</dd>
              </div>
              {status.state === "connected" ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">Credentials</dt>
                  <dd>{status.credentialPersistence === "os-vault" ? "Secure vault on this computer" : "This app session only"}</dd>
                </div>
              ) : null}
              {status.state === "connected" && expiry ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">Session until</dt>
                  <dd>{expiry}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {status?.state === "connected" && status.credentialPersistence === "session" ? (
            <p className="mt-3 flex items-start gap-2 text-xs text-amber-300/90">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              No OS credential vault was available; the sign-in is held in memory only and is discarded when the app closes.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {state === "connecting" ? (
          <>
            <Button className="h-10 gap-2 rounded-full bg-[#E8E044] text-black" disabled>
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Waiting for approval
            </Button>
            <Button
              className="h-10 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5"
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
              className="flex w-full flex-col gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4"
              role="alertdialog"
              aria-labelledby="cloud-disconnect-title"
              aria-describedby="cloud-disconnect-detail"
            >
              <p id="cloud-disconnect-title" className="text-sm font-semibold">Disconnect from SimCloud?</p>
              <p id="cloud-disconnect-detail" className="text-xs leading-5 text-white/60">
                Maps that need an account and cloud storage lock until you connect again. Local projects, renders and
                documents on this computer are kept.
              </p>
              <div className="flex gap-2">
                <Button
                  className="h-9 gap-2 rounded-full bg-amber-300 text-black hover:bg-amber-200"
                  disabled={loading}
                  onClick={() => {
                    setConfirmDisconnect(false);
                    void disconnect();
                  }}
                  type="button"
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  Disconnect
                </Button>
                <Button
                  autoFocus
                  className="h-9 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5"
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
              <Button asChild className="h-10 gap-2 rounded-full bg-[#E8E044] text-black hover:bg-[#f1ea55]">
                <Link href="/dashboard/cloud-storage">
                  <Cloud className="size-4" aria-hidden="true" />
                  Open cloud storage
                </Link>
              </Button>
              <Button
                className="h-10 gap-2 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5"
                disabled={loading}
                onClick={() => setConfirmDisconnect(true)}
                type="button"
                variant="outline"
              >
                <LogOut className="size-4" aria-hidden="true" />
                Disconnect
              </Button>
            </>
          )
        ) : (
          <Button
            className="h-10 gap-2 rounded-full bg-[#E8E044] text-black hover:bg-[#f1ea55] disabled:opacity-60"
            disabled={loading || status === null}
            onClick={() => void connect()}
            type="button"
          >
            {loading ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink className="size-4" aria-hidden="true" />
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
      className="flex min-w-0 items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5"
      data-testid="cloud-connection-chip"
      data-cloud-state={state ?? "loading"}
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-sm", stateDotClass(state))} />
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 font-meta text-[8px] font-bold uppercase tracking-[0.16em] text-white/30">SimCloud</p>
        <p className="truncate text-xs font-semibold text-white/80" title={summary}>
          {summary}
        </p>
      </div>
      {state === "connected" || state === "connecting" ? (
        <Link
          className="shrink-0 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-[10px] font-medium text-white/50 transition-colors hover:border-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
          href="/dashboard/settings"
          onClick={onNavigate}
        >
          Manage
        </Link>
      ) : (
        <button
          className="shrink-0 rounded-lg border border-[#E8E044]/30 bg-[#E8E044]/10 px-2.5 py-1.5 text-[10px] font-semibold text-[#E8E044] transition-colors hover:bg-[#E8E044]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] disabled:opacity-50"
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
