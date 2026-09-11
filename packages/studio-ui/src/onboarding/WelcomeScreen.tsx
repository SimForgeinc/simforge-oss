"use client";

import { ExternalLink, LoaderCircle } from "lucide-react";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import { Button } from "../components/ui/button";
import { HeroBackdrop } from "./HeroBackdrop";

/**
 * The first screen of a fresh installation: sign in to SimCloud, or continue
 * locally with the one public map. Props only — the host app owns the PKCE
 * flow, the connection polling and where each action leads.
 */
export function WelcomeScreen({
  cloudState,
  userEmail,
  error,
  busy,
  onSignIn,
  onContinueLocally,
}: {
  /** `null` until the local service has answered once. */
  cloudState: StudioCloudStatus["state"] | null;
  userEmail: string | null;
  error: string | null;
  /** A connect request or its consent poll is in flight. */
  busy: boolean;
  onSignIn: () => void;
  onContinueLocally: () => void;
}) {
  const connecting = cloudState === "connecting";
  const connected = cloudState === "connected";

  return (
    <main
      className="relative grid min-h-svh place-items-center overflow-hidden bg-[#050607] px-6 py-12 text-white"
      data-testid="onboarding-welcome"
      data-cloud-state={cloudState ?? "unknown"}
    >
      <HeroBackdrop />
      <section className="relative z-10 w-full max-w-2xl">
        <p className="font-meta text-[10px] font-bold uppercase tracking-[0.22em] text-[#E8E044]">
          SimForge Studio
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Welcome to SimForge Studio</h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-white/60">
          Studio turns real streets into simulation-ready digital twins on this computer. Sign in to
          SimCloud for your account&apos;s maps and cloud storage, or continue locally with the public
          Richmond Field Station map.
        </p>

        {connected && userEmail ? (
          <p className="mt-6 text-sm text-[#E8E044]" data-testid="onboarding-welcome-account">
            Signed in as {userEmail}
          </p>
        ) : null}
        {error ? (
          <p className="mt-6 max-w-xl text-sm leading-6 text-amber-300/90" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Button
            autoFocus
            className="h-12 flex-1 rounded-full bg-[#E8E044] text-black hover:bg-[#E8E044]/85"
            data-testid="onboarding-sign-in"
            disabled={busy || connecting}
            onClick={connected ? onContinueLocally : onSignIn}
            type="button"
          >
            {connecting ? (
              <>
                <LoaderCircle className="mr-1 size-4 animate-spin" aria-hidden="true" />
                Waiting for approval…
              </>
            ) : connected ? (
              "Continue with SimCloud"
            ) : (
              <>
                <ExternalLink className="mr-1 size-4" aria-hidden="true" />
                Sign in to SimCloud
              </>
            )}
          </Button>
          <Button
            className="h-12 flex-1 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5"
            data-testid="onboarding-continue-locally"
            onClick={onContinueLocally}
            type="button"
            variant="outline"
          >
            Continue locally
          </Button>
        </div>
        <p className="mt-4 text-xs text-white/35">
          You can sign in later from Settings; nothing here is permanent.
        </p>
      </section>
    </main>
  );
}
