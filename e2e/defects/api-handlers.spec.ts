/**
 * Defect class 3 — API handlers deleted by an unrelated commit.
 *
 * Commit `e3bf1229` removed the `POST` from
 * `studio/app/api/simforge/documents/[documentId]/simulation-preview/route.ts`
 * and the only handler from `.../simulation-preview/complete/route.ts`,
 * leaving one route module with `GET` alone and one with no handler at all.
 * Each handler was a single line beginning with an origin-guard call, which is
 * how a cleanup swept them. Nothing went red: the callers were fine, the
 * remaining handler was fine, and no unit test asserts that a module still
 * exports a function it used to export.
 *
 * Two assertions cover the class from the source side, and
 * `defects-live/simulation-preview-chain.spec.ts` covers it from the live
 * server side. Both are wanted: the static one names the file the instant a
 * handler disappears, the live one proves the chain the handlers exist for
 * actually completes.
 */

import { apiRoutes, collectUrlUsage, resolveRoute, routesBeneath, type RouteEntry, type UrlUsage } from "../support/app-routes";
import { readable } from "../support/source-scan";
import { expect, test } from "../support/fixtures";

/**
 * Callees whose first argument is a URL but *not* one this route table can
 * answer for. `cloudRequest`, `cloudAuthRequest`, `cloudPublicRequest` and
 * `cloudJson` all talk to the SimCloud platform (`simcloud-platform`), so a
 * `/api/...` path they carry is served by a different deployment entirely —
 * `real/cloud-auth.spec.ts` is what covers those, against the real
 * environment. `URL` and `startsWith` are not requests at all; they take a
 * path as data.
 *
 * A denylist rather than an allowlist on purpose: the product has a dozen
 * request helpers (`fetch`, `request`, `fetchImpl`, `hostRequest`,
 * `requestJson`, `useJsonFetch`, `getJson`, `upstreamGet`, …) and new ones
 * appear. An allowlist would silently stop covering a helper the day someone
 * adds it, which is the same "nothing went red" failure this file exists to
 * prevent.
 */
const NON_STUDIO_CALLEES: Record<string, true> = {
  URL: true,
  startsWith: true,
  cloudRequest: true,
  cloudAuthRequest: true,
  cloudPublicRequest: true,
  cloudJson: true,
};

/**
 * `/api/desktop/**` is the SimCloud platform's own API surface, not this
 * repository's App Router.
 */
const PLATFORM_PREFIX = "/api/desktop/";

/**
 * Requests whose route genuinely does not exist, with the symptom a user
 * sees. These are live defects this test found, not exemptions of
 * convenience: recording them keeps the suite honest about the difference
 * between "known broken" and "newly broken", so a *new* dangling call fails
 * immediately instead of joining an unbounded list.
 *
 * None of these was ever deleted — there is no `app/api/simforge/compute`
 * directory and never was, and `studio/next.config.ts` rewrites only
 * `/streams/:path*`, so nothing else serves them.
 */
const KNOWN_DANGLING: Record<string, string> = {
  "/api/simforge/compute/capabilities":
    "the Evaluation comparison launcher renders \"Compute unavailable (HTTP 404)\" permanently",
  "/api/simforge/compute/jobs":
    "submitting a cloud comparison throws \"compute job rejected (HTTP 404)\"; called same-origin from"
    + " studio/app/api/evaluation/comparisons/route.ts:162",
  "/api/carla-compatibility": "loadCarlaCompatibility() always rejects with \"Could not load CARLA compatibility (404)\"",
  "/api/carla-objects": "loadCatalog() always rejects with \"Could not load CARLA objects (404)\"",
};

/** Requests this repository's own App Router is responsible for serving. */
async function studioRequests(): Promise<UrlUsage[]> {
  const usage = await collectUrlUsage(["/api/"]);
  return usage.filter((site) =>
    site.callee !== null
    && NON_STUDIO_CALLEES[site.callee] !== true
    && !site.value.startsWith(PLATFORM_PREFIX));
}

test.describe("API route modules export the handlers their callers use", () => {
  test("every route module under studio/app/api exports at least one HTTP verb", async () => {
    const routes = await apiRoutes();
    // Guards the scan itself: 208 route modules existed when this was
    // written, so a tiny result means the directory walk broke rather than
    // that the API shrank by 90%. Without a floor, every assertion below
    // would pass over an empty set and certify nothing.
    expect(routes.length, "route modules found by the scan").toBeGreaterThan(150);

    const handlerless = routes.filter((route: RouteEntry) => route.verbs.length === 0);
    // The assertion that catches `complete/route.ts` losing its only handler.
    // A `route.ts` that Next.js mounts with nothing to mount is never
    // intentional: it 405s every caller, and its own imports still typecheck.
    expect(handlerless.map((route) => route.file), "route modules with no handler at all").toEqual([]);
  });

  test("every request the product makes has a route module exporting that verb", async () => {
    const routes = await apiRoutes();
    const requests = await studioRequests();
    expect(requests.length, "in-app request sites found by the scan").toBeGreaterThan(100);

    const dangling: string[] = [];
    const wrongVerb: string[] = [];
    const resolvedAfterAll: string[] = [];
    for (const site of requests) {
      // A base the code appends an unknown suffix to (`` `${CLOUD_ROOT}${path}` ``).
      // All that can be asserted is that the namespace exists — either as a
      // route in its own right or with routes beneath it.
      if (site.prefixOnly) {
        const exists = resolveRoute(routes, site.segments) !== null || routesBeneath(routes, site.segments).length > 0;
        if (!exists) dangling.push(`${readable(site.value)} names an empty namespace (${site.site})`);
        continue;
      }
      const route = resolveRoute(routes, site.segments);
      if (route === null) {
        if (KNOWN_DANGLING[site.value] !== undefined) continue;
        dangling.push(`${site.method ?? "?"} ${readable(site.value)} (${site.site})`);
        continue;
      }
      if (KNOWN_DANGLING[site.value] !== undefined) resolvedAfterAll.push(site.value);
      // `null` means the call site passes options this scan cannot read
      // exactly — a spread, a variable, or a `method` in a third argument.
      // Asserting a verb there would be a guess, and a guess here invents
      // failures; the route-exists assertion above still applies.
      if (site.method !== null && !route.verbs.includes(site.method as never)) {
        wrongVerb.push(
          `${site.method} ${readable(site.value)} -> ${route.file} exports [${route.verbs.join(", ")}] (${site.site})`,
        );
      }
    }

    // The defect shape exactly: the caller POSTs, the module offers GET only.
    expect(wrongVerb, "requests whose route module does not export the verb used").toEqual([]);
    expect(dangling, "requests with no route module behind them").toEqual([]);
    // Stop the baseline rotting. Once one of these is implemented its entry
    // must go, or it keeps shielding a path that no longer needs shielding.
    expect(
      resolvedAfterAll,
      "KNOWN_DANGLING entries that now resolve and must be deleted from that list",
    ).toEqual([]);
  });
});
