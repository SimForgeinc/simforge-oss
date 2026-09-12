"use client";

import { ExternalLink, LoaderCircle } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import { Button } from "../components/ui/button";
import { HeroBackdrop } from "./HeroBackdrop";
import { onboarding } from "./onboarding.stylex";

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
      {...stylex.props(onboarding.welcomeScreen)}
      data-testid="onboarding-welcome"
      data-cloud-state={cloudState ?? "unknown"}
    >
      <HeroBackdrop />
      <section {...stylex.props(onboarding.welcomeColumn)}>
        <p {...stylex.props(onboarding.eyebrow)}>SimForge Studio</p>
        <h1 {...stylex.props(onboarding.welcomeTitle)}>Welcome to SimForge Studio</h1>
        <p {...stylex.props(onboarding.welcomeLede)}>
          Studio turns real streets into simulation-ready digital twins on this computer. Sign in to
          SimCloud for your account&apos;s maps and cloud storage, or continue locally with the public
          Richmond Field Station map.
        </p>

        {connected && userEmail ? (
          <p {...stylex.props(onboarding.accountNote)} data-testid="onboarding-welcome-account">
            Signed in as {userEmail}
          </p>
        ) : null}
        {error ? (
          <p {...stylex.props(onboarding.cautionNote)} role="alert">
            {error}
          </p>
        ) : null}

        <div {...stylex.props(onboarding.welcomeActions)}>
          <Button
            autoFocus
            xstyle={onboarding.primaryAction}
            data-testid="onboarding-sign-in"
            disabled={busy || connecting}
            onClick={connected ? onContinueLocally : onSignIn}
            type="button"
          >
            {connecting ? (
              <>
                <LoaderCircle {...stylex.props(onboarding.icon, onboarding.iconWithLabel, onboarding.spinner)} aria-hidden="true" />
                Waiting for approval…
              </>
            ) : connected ? (
              "Continue with SimCloud"
            ) : (
              <>
                <ExternalLink {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
                Sign in to SimCloud
              </>
            )}
          </Button>
          <Button
            xstyle={onboarding.secondaryAction}
            data-testid="onboarding-continue-locally"
            onClick={onContinueLocally}
            type="button"
            variant="outline"
          >
            Continue locally
          </Button>
        </div>
        <p {...stylex.props(onboarding.footnote)}>
          You can sign in later from Settings; nothing here is permanent.
        </p>
      </section>
    </main>
  );
}
