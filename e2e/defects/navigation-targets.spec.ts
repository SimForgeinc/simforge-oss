/**
 * Defect class 1 — a button that navigates to a route which does not exist.
 *
 * The bug: the scenario list's Driver-in-the-Loop control pushed
 * `/dashboard/scenario/<documentId>/drive`, while the page serving a drive
 * lives at `studio/app/dashboard/drive/[documentId]/page.tsx`. Pressing the
 * control minted a variation and then landed the user on a 404. Both halves
 * were individually correct and individually unit-tested, so nothing was red:
 * the defect existed only in the relationship between a string and a
 * directory, and no test that looks at one file can see a relationship.
 *
 * `studio/app/lib/scenario/__tests__/driver-in-the-loop.test.ts` pins that one
 * URL. This generalises it to every navigation target the product constructs,
 * which is the assertion that would have caught it without anyone having to
 * think of the drive route first.
 */

import { pageRoutes, collectUrlUsage, resolveRoute, type UrlUsage } from "../support/app-routes";
import { readable } from "../support/source-scan";
import { expect, test } from "../support/fixtures";

/** Prefixes under which every App Router page lives. */
const IN_APP_PREFIXES = ["/dashboard", "/onboarding"] as const;

test.describe("every navigation target resolves to a page", () => {
  test("no UI surface constructs a path the App Router cannot serve", async () => {
    const pages = await pageRoutes();
    const targets = await collectUrlUsage(IN_APP_PREFIXES);

    // A guard on the scan itself. If a refactor moved these sources, or the
    // scanner stopped recognising template literals, every assertion below
    // would pass over an empty set and certify nothing. The floor is well
    // under the 109 targets and 31 pages present when this was written, so it
    // only fires on a scan that has genuinely stopped working.
    expect(pages.length, "App Router pages found by the scan").toBeGreaterThan(20);
    expect(targets.length, "navigation targets found by the scan").toBeGreaterThan(60);

    // `prefixOnly` targets are bases the code appends to before navigating;
    // the concrete path is not knowable here, so they are covered by the
    // live projects rather than asserted against a single page.
    const unresolved = targets.filter((target) =>
      !target.prefixOnly && resolveRoute(pages, target.segments) === null);
    expect(
      unresolved.map((target) => `${readable(target.value)} (${target.site})`),
      "navigation targets with no page behind them",
    ).toEqual([]);
  });

  test("the drive control's target is a dynamic-segment page, not a literal one", async () => {
    // The specific shape of the original bug: a trailing literal segment
    // (`…/<id>/drive`) cannot be served by a dynamic route, so it is precisely
    // the case a permissive matcher would wave through. Asserting the
    // resolution *identity* — which file serves it — rather than merely "it
    // resolved" keeps the general test above honest, because a matcher bug
    // that made everything resolve would still fail here.
    const pages = await pageRoutes();
    const targets = await collectUrlUsage(IN_APP_PREFIXES);
    const drive = targets.find((target: UrlUsage) => target.value.startsWith("/dashboard/drive/"));
    expect(drive, "a drive navigation target exists in the product sources").toBeDefined();
    const route = resolveRoute(pages, drive!.segments);
    expect(route?.file).toBe("studio/app/dashboard/drive/[documentId]/page.tsx");
  });
});
