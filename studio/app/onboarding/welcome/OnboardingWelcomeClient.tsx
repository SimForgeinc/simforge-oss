"use client";

import { useRouter } from "next/navigation";
import { WelcomeScreen } from "@simforge-oss/studio-ui/onboarding";
import { CloudAccountPanel } from "@/app/components/cloud/CloudAccountPanel";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import { inlineSignIn } from "../onboarding-layout.stylex";

const MAPS_PATH = "/onboarding/maps";

/**
 * Step 1: sign in to SimCloud, or continue locally.
 *
 * The account flow is inline in the page (email + password, sign-up, or the
 * Google/GitHub browser hop) — the same pieces every other surface composes,
 * with no sheet over the column. Only a sign-in the user actually completed
 * here advances the flow: a data root that is already connected still shows
 * this screen, because the user may well want to review it before
 * downloading anything.
 */
export function OnboardingWelcomeClient() {
  const router = useRouter();
  const cloud = useStudioCloudStatus();
  const state = cloud.status?.state ?? null;
  const connected = state === "connected";

  return (
    <WelcomeScreen
      busy={cloud.loading}
      cloudState={state}
      // Signed out, the inline flow reports its own failures; showing
      // `cloud.error` here as well would print the same line twice.
      error={connected ? cloud.error : null}
      onContinueLocally={() => router.push(MAPS_PATH)}
      signIn={
        connected ? undefined : (
          <CloudAccountPanel onSignedIn={() => router.replace(MAPS_PATH)} xstyle={inlineSignIn.panel} />
        )
      }
      userEmail={cloud.status?.state === "connected" ? (cloud.status.user?.email ?? null) : null}
    />
  );
}
