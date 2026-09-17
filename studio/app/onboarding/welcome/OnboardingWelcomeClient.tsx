"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { WelcomeScreen } from "@simforge-oss/studio-ui/onboarding";
import { CloudAccountPanel } from "@/app/components/cloud/CloudAccountPanel";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import { inlineSignIn } from "../onboarding-layout.stylex";

const MAPS_PATH = "/onboarding/maps";

/**
 * Step 1: sign in to SimCloud, or continue locally.
 *
 * The two choices come first; asking to sign in reveals the account flow
 * (email + password, sign-up, or the Google/GitHub browser hop) inline in the
 * column — the same pieces every other surface composes, with no sheet over
 * it. Only a sign-in the user actually completed here advances the flow: a
 * data root that is already connected still shows this screen, because the
 * user may well want to review it before downloading anything.
 */
export function OnboardingWelcomeClient() {
  const router = useRouter();
  const cloud = useStudioCloudStatus();
  const [revealed, setRevealed] = useState(false);
  const state = cloud.status?.state ?? null;
  const connected = state === "connected";
  // Signed in, the account note and "Continue with SimCloud" say everything
  // that is left to say, so the flow has nothing to add.
  const signingIn = revealed && !connected;

  return (
    <WelcomeScreen
      busy={cloud.loading}
      cloudState={state}
      // The revealed flow reports its own failures; showing `cloud.error`
      // here as well would print the same line twice. Closed, this is the
      // only place a failed browser hop could be reported.
      error={signingIn ? null : cloud.error}
      onCancelSignIn={state === "connecting" ? undefined : () => setRevealed(false)}
      onContinueLocally={() => router.push(MAPS_PATH)}
      onSignIn={() => setRevealed(true)}
      signIn={
        signingIn ? (
          <CloudAccountPanel onSignedIn={() => router.replace(MAPS_PATH)} xstyle={inlineSignIn.panel} />
        ) : undefined
      }
      userEmail={cloud.status?.state === "connected" ? (cloud.status.user?.email ?? null) : null}
    />
  );
}
