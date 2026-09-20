import { requireAppContext } from "@/app/lib/db/app-context";
import { OnboardingWelcomeClient } from "./OnboardingWelcomeClient";

/**
 * Opt the route out of instant-navigation prerendering.
 *
 * `requireAppContext()` is a frozen constant on a local install, so this page
 * happens to prerender there. On a host that resolves the signed-in person
 * from the request — the same `AppContext` export, a different implementation
 * — the body performs a blocking dynamic access, which a prerender cannot do.
 * The route is per-request either way; saying so here keeps the page honest on
 * both hosts instead of prerendering on one and failing the build on the other.
 */
export const instant = false;

export default async function OnboardingWelcomePage() {
  await requireAppContext("/onboarding/welcome");
  return <OnboardingWelcomeClient />;
}
