"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StudioCloudStatus } from "@simforge-oss/studio-host";
import { Button } from "../components/ui/button";
import { onboarding } from "./onboarding.stylex";

/**
 * The first onboarding step: sign in to SimCloud, or continue locally with
 * the one public map. Renders into the host's onboarding column - the hero
 * behind it and the column geometry belong to the host's route layout, so
 * the next step can replace this copy in place. Props only: the host app
 * owns the connection state, where each action leads, and the sign-in flow
 * itself, which arrives as a node this screen places in the page body -
 * under the lede, never behind an overlay.
 */
export function WelcomeScreen({
  cloudState,
  userEmail,
  error,
  busy,
  signIn,
  onContinueLocally,
}: {
  /** `null` until the local service has answered once. */
  cloudState: StudioCloudStatus["state"] | null;
  userEmail: string | null;
  error: string | null;
  /** An account request, or the Google/GitHub browser hop, is in flight. */
  busy: boolean;
  /**
   * The host's sign-in flow, rendered inline in this column. Omitted once
   * there is a session: the account note and "Continue with SimCloud" say
   * everything that is left to say.
   */
  signIn?: ReactNode;
  onContinueLocally: () => void;
}) {
  const connected = cloudState === "connected";

  return (
    <section
      data-testid="onboarding-welcome"
      data-cloud-state={cloudState ?? "unknown"}
    >
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

        {signIn ? (
          <div {...stylex.props(onboarding.signInSlot)} data-testid="onboarding-sign-in">
            {signIn}
          </div>
        ) : null}

        <div {...stylex.props(onboarding.welcomeActions)}>
          {connected ? (
            <Button
              autoFocus
              xstyle={onboarding.primaryAction}
              data-testid="onboarding-continue-cloud"
              disabled={busy}
              onClick={onContinueLocally}
              type="button"
            >
              Continue with SimCloud
            </Button>
          ) : null}
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
  );
}
