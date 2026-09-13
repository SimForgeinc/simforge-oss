import { test as base, expect } from "@playwright/test";
import { createE2eContext, type E2eContext } from "./context";
import { setActiveEvidenceTarget } from "./evidence";
import { launchStudio, type StudioSession } from "./session";

export type E2eFixtures = {
  /** This test's isolated roots, environment overlay and teardown list. */
  e2e: E2eContext;
  /** A running Studio in the configured mode, already on the scenario dashboard. */
  studio: StudioSession;
};

/**
 * The harness test object. `e2e` is always available and cheap; `studio` boots
 * a real supervisor and is therefore requested only by the tests that drive
 * the product.
 */
export const test = base.extend<E2eFixtures>({
  e2e: async ({}, use, testInfo) => {
    const context = await createE2eContext({ name: testInfo.titlePath.join("-") || testInfo.title });
    setActiveEvidenceTarget(testInfo);
    try {
      await use(context);
    } finally {
      setActiveEvidenceTarget(undefined);
      await context.dispose();
    }
  },
  studio: async ({ e2e }, use) => {
    const session = await launchStudio(e2e);
    try {
      await use(session);
    } finally {
      await session.close();
    }
  },
});

export { expect };
/** Explicit alias for suites that already import a `test` from elsewhere. */
export const e2eTest = test;
