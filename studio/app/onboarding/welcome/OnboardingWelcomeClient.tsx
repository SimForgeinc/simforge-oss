"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { WelcomeScreen } from "@simforge-oss/studio-ui/onboarding";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

const MAPS_PATH = "/onboarding/maps";

/**
 * Step 1: sign in to SimCloud, or continue locally.
 *
 * Sign-in is the existing PKCE flow — the consent page opens in the system
 * browser and `useStudioCloudStatus().connect()` polls the local service until
 * it settles. Only a sign-in the user actually started advances the flow: a
 * data root that is already connected still shows this screen, because the
 * user may well want to review it before downloading anything.
 */
export function OnboardingWelcomeClient() {
  const router = useRouter();
  const cloud = useStudioCloudStatus();
  const requested = useRef(false);
  const state = cloud.status?.state ?? null;

  useEffect(() => {
    if (requested.current && state === "connected") router.replace(MAPS_PATH);
  }, [state, router]);

  return (
    <WelcomeScreen
      busy={cloud.loading}
      cloudState={state}
      error={cloud.error}
      onContinueLocally={() => router.push(MAPS_PATH)}
      onSignIn={() => {
        requested.current = true;
        void cloud.connect();
      }}
      userEmail={cloud.status?.state === "connected" ? (cloud.status.user?.email ?? null) : null}
    />
  );
}
