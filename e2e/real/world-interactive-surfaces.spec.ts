/**
 * Defect class 2 — an interactive surface rendered under
 * `pointer-events: none` — and the canvas-paint check that class 2's
 * investigation produced.
 *
 * The bug: the datasets page mounts a coverage map inside `styles.divRelative`
 * (`ScenarioDatasetsClient.tsx:732`), which carries `pointer-events: none`.
 * That was right for the decorative 3D scene it replaced and fatal for an
 * interactive map. The map was visible, correctly sized, correctly styled —
 * and silently swallowed every click. `toBeVisible()` passes on it. A
 * Playwright click "succeeds" on it, because the event is dispatched at the
 * coordinate and something else receives it. Only asking what is actually at
 * the point catches this.
 *
 * The second test exists because of a mistake made while investigating the
 * first: a "frozen scene" was reported today from fingerprinting an
 * arbitrary canvas. The page holds two WebGL canvases and the decorative one
 * never changes. So the readback helper refuses to sample an unnamed canvas,
 * and this asserts the world host actually paints.
 */

import { launchBrowserStudio, type StudioSession } from "../support/session";
import { forcePreserveDrawingBuffer, hitTestCentre, readCanvasFrame } from "../support/surfaces";
import { expect, test } from "../support/fixtures";

const COVERAGE_MAP = '[data-testid="scenario-coverage-map"]';
const WORLD_HOST = '[data-testid="scenario-world-host"]';

test.describe("interactive surfaces actually receive input", () => {
  let studio: StudioSession;

  test.beforeAll(async ({ e2e }) => {
    studio = await launchBrowserStudio(e2e, {
      route: "/dashboard/scenario",
      // Installed before the first navigation: the world canvas takes its
      // WebGL context during mount, and a context created without
      // `preserveDrawingBuffer` reads back blank no matter when it is sampled.
      async beforeNavigate(page) {
        await forcePreserveDrawingBuffer(page);
      },
    });
  });

  test.afterAll(async () => {
    await studio?.close();
  });

  test("the coverage map is the element under the point a user clicks", async () => {
    const map = studio.page.locator(COVERAGE_MAP);
    await expect(map).toBeVisible({ timeout: 120_000 });
    // Visibility first, then reachability — and the two disagreeing is
    // exactly the defect. Asserting visibility alone is what let this ship.
    const hit = await hitTestCentre(studio.page, COVERAGE_MAP);
    expect(
      hit.blockedBy,
      `an ancestor of the coverage map sets pointer-events: none (${hit.blockedBy})`,
    ).toBeNull();
    expect(
      hit.reachesTarget,
      `a click at (${hit.x}, ${hit.y}) lands on ${hit.topmost} instead of the coverage map`,
    ).toBe(true);
    // The map renders through MapLibre, so the element taking the event has
    // to be its canvas; a wrapper receiving it would still not pan or zoom.
    expect(hit.topmost, "the element under the map's centre").toContain("maplibregl-canvas");
  });

  test("dragging the coverage map moves the camera", async () => {
    // Hit-testing proves the event can arrive; this proves the map does
    // something with it. Both are needed: a canvas that receives events but
    // has no interaction handlers attached is equally dead to a user, and
    // that is a different bug with the same symptom.
    const map = studio.page.locator(COVERAGE_MAP);
    await expect(map).toBeVisible({ timeout: 120_000 });
    const box = await map.boundingBox();
    expect(box, "the coverage map's box").not.toBeNull();

    const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    const before = await readCanvasFrame(studio.page, COVERAGE_MAP);
    await studio.page.mouse.move(centre.x, centre.y);
    await studio.page.mouse.down();
    await studio.page.mouse.move(centre.x - 140, centre.y - 90, { steps: 12 });
    await studio.page.mouse.up();
    await studio.page.waitForTimeout(1_500);
    const after = await readCanvasFrame(studio.page, COVERAGE_MAP);

    // The frame is the observable a user sees. Reading an internal camera
    // object would pass on a map that updates its state and never repaints.
    expect(
      after.fingerprint,
      `the map painted an identical frame after a 140x90 drag (${before.fingerprint})`,
    ).not.toBe(before.fingerprint);
  });

  test("the coverage map paints a real frame, not a blank one", async () => {
    await expect(studio.page.locator(COVERAGE_MAP)).toBeVisible({ timeout: 120_000 });
    // Settle: MapLibre paints the basemap over several frames.
    await studio.page.waitForTimeout(4_000);
    const frame = await readCanvasFrame(studio.page, COVERAGE_MAP);
    expect(frame.width, "the map canvas has a real size").toBeGreaterThan(200);
    // A single-colour frame is the failure mode that looks like success: the
    // canvas is present, sized and composited, and shows nothing. Peers
    // measured 8364 distinct colours on a painted world canvas and 1 on a
    // dead one, so the floor is set far below a real frame and far above a
    // dead one.
    expect(frame.distinctColours, `distinct colours in the map frame`).toBeGreaterThan(16);
    expect(frame.nonBlackFraction, "fraction of the map frame that is not black").toBeGreaterThan(0.2);
  });
});

test.describe("the 3D world paints when a scenario is open", () => {
  test("the world host's canvas shows a rendered scene", async ({ e2e }) => {
    const session = await launchBrowserStudio(e2e, {
      route: "/dashboard/scenario",
      async beforeNavigate(page) {
        await forcePreserveDrawingBuffer(page);
      },
    });
    try {
      const host = session.page.locator(WORLD_HOST);
      // The datasets list mounts the 3D world only during editing, so this
      // waits for the surface rather than assuming the landing route has it.
      await expect(host).toBeVisible({ timeout: 300_000 });
      await session.page.waitForTimeout(6_000);
      // `readCanvasFrame` throws if the host holds zero or several canvases.
      // That refusal is deliberate: sampling "the first canvas on the page"
      // is what produced a false frozen-scene report, because the page also
      // carries a decorative WebGL canvas that never changes.
      const frame = await readCanvasFrame(session.page, WORLD_HOST);
      expect(frame.distinctColours, "distinct colours in the world frame").toBeGreaterThan(64);
      expect(frame.nonBlackFraction, "fraction of the world frame that is not black").toBeGreaterThan(0.2);
      expect(frame.opaqueFraction, "fraction of the world frame that is opaque").toBeGreaterThan(0.9);
    } finally {
      await session.close();
    }
  });
});
