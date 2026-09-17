"use client";

import type { ReactNode } from "react";
import { LoaderCircle, LogIn } from "lucide-react";
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
 * itself.
 *
 * The two choices come first. Asking for the sign-in flow replaces them, in
 * place, with the host's {@link signIn} node - in the page body, never behind
 * an overlay - so the column shows one decision at a time.
 */
export function WelcomeScreen({
  cloudState,
  userEmail,
  error,
  busy,
  signIn,
  onSignIn,
  onCancelSignIn,
  onContinueLocally,
}: {
  /** `null` until the local service has answered once. */
  cloudState: StudioCloudStatus["state"] | null;
  userEmail: string | null;
  error: string | null;
  /** An account request, or the Google/GitHub browser hop, is in flight. */
  busy: boolean;
  /**
   * The host's sign-in flow, once the user has asked for it. Present, it
   * takes the place of the actions row; absent, the two choices are what the
   * column offers.
   */
  signIn?: ReactNode;
  onSignIn: () => void;
  /**
   * Leaves the sign-in flow for the two choices again. Omitted while the
   * flow owns its own dismissal — the browser hop already offers Cancel, and
   * two of them beside each other would mean two different things.
   */
  onCancelSignIn?: () => void;
  onContinueLocally: () => void;
}) {
  const connecting = cloudState === "connecting";
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
          <div {...stylex.props(onboarding.signInSlot)} data-testid="onboarding-sign-in-flow">
            {signIn}
            {onCancelSignIn ? (
              <Button
                xstyle={onboarding.signInDismiss}
                data-testid="onboarding-sign-in-cancel"
                onClick={onCancelSignIn}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : (
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
                  Finishing in your browser…
                </>
              ) : connected ? (
                "Continue with SimCloud"
              ) : (
                <>
                  <LogIn {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
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
        )}
        <p {...stylex.props(onboarding.footnote)}>
          You can sign in later from Settings; nothing here is permanent.
        </p>
    </section>
  );
}
