import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Simulation history end to end, on a running Studio host whose drafts were simulated under an
 * older engine and which now runs a newer one (see e2e/tools/sim-history-seed.mts):
 *
 *   engine-change banner -> compare -> keep the old motion as a version -> Versions panel ->
 *   use the new engine's simulation -> roll back to the old one -> compare (dual playback).
 *
 * Environment:
 *   SIM_HISTORY_BASE_URL   the URL the user opens (HTTPS on the tailnet: a secure context)
 *   SIM_HISTORY_ROOT       the host's SIMFORGE_CLOUD_ROOT (its control token mints the session)
 *   SIM_HISTORY_SEEDED     seeded.json written by the seed script
 *   SIM_HISTORY_DOCUMENT   index of the seeded document to use (default 0)
 *   SIM_HISTORY_SHOTS      directory for step screenshots (optional)
 */

const BASE = process.env.SIM_HISTORY_BASE_URL ?? "";
const ROOT = process.env.SIM_HISTORY_ROOT ?? "";
const SEEDED = process.env.SIM_HISTORY_SEEDED ?? "";
const SHOTS = process.env.SIM_HISTORY_SHOTS ?? "";

test.skip(!BASE || !ROOT || !SEEDED, "needs a seeded Studio host (SIM_HISTORY_BASE_URL, SIM_HISTORY_ROOT, SIM_HISTORY_SEEDED)");

type Seeded = { datasetId: string; made: Array<{ id: string; draftVersion: number; simKey: string; engine: string }> };

async function loginUrl(next: string): Promise<string> {
  const host = JSON.parse(readFileSync(join(ROOT, "host.json"), "utf8")) as { baseUrl: string; controlToken: string };
  const response = await fetch(`${host.baseUrl}/api/simforge/host/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ next }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`session ticket failed: ${response.status}`);
  const { url } = (await response.json()) as { url: string };
  return url.replace(host.baseUrl, BASE);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test("engine change: keep the old motion, use the new one, roll back, compare", async ({ page, context }) => {
  test.setTimeout(20 * 60_000);
  const seeded = JSON.parse(readFileSync(SEEDED, "utf8")) as Seeded;
  const doc = seeded.made[Number(process.env.SIM_HISTORY_DOCUMENT ?? "0")]!;
  expect(doc.engine, "the seed simulated under the previous engine").toBe("0.9.0");

  // First-run onboarding and tutorials are not what this test is about.
  await context.route("**/api/simforge/host/setup", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ completedAt: "2026-09-22T00:00:00.000Z", mode: "local", quality: "medium" }) })
    : route.continue());
  await context.addInitScript(() => {
    try {
      localStorage.setItem("simcloud.uniscenario.editor-experience.v1", "advanced");
      for (const mode of ["simple", "advanced"]) localStorage.setItem(`uniscenario.tutorial.completed.v2.${mode}`, "1");
      localStorage.setItem("simcloud.uniscenario.simple-route-tutorial.v1", "1");
    } catch {
      // Storage may be unavailable; the tutorials then show and are dismissed below.
    }
  });

  await page.goto(await loginUrl(`/dashboard/scenario?dataset=${seeded.datasetId}&document=${doc.id}`), { waitUntil: "commit", timeout: 10 * 60_000 });

  // 1. The banner: the draft is unchanged, the engine moved, the motion differs.
  const banner = page.getByTestId("engine-change-banner");
  await expect(banner).toBeVisible({ timeout: 10 * 60_000 });
  await expect(banner).toContainText("Motion changed with Engine 0.10.0");
  await expect(banner).toContainText("since Engine 0.9.0");
  await shot(page, "01-engine-change-banner");

  // 2. Compare from the banner: both motions on one stage.
  await banner.getByTestId("engine-change-compare").click();
  const compare = page.getByTestId("scenario-compare-dialog");
  await expect(compare.getByTestId("scenario-compare-stage")).toBeVisible({ timeout: 120_000 });
  await expect(compare.getByTestId("scenario-compare-diff")).toContainText(/changed/);
  await shot(page, "02-banner-compare");
  await page.keyboard.press("Escape");
  await expect(compare).toBeHidden();

  // 3. Keep the 0.9.0 motion as a version.
  await banner.getByTestId("engine-change-keep").click();
  await expect(banner).toContainText(/Saved Version \d+ with the Engine 0\.9\.0 motion/, { timeout: 120_000 });
  await shot(page, "03-kept-old-motion");

  // 4. The Versions panel: the kept version renders the old engine's result.
  await page.getByTestId("scenario-versions-button").click();
  const panel = page.getByTestId("scenario-versions-panel");
  await expect(panel).toBeVisible();
  const kept = panel.getByTestId("scenario-version").filter({ hasText: "Kept previous motion" }).first();
  await expect(kept).toBeVisible({ timeout: 60_000 });
  const oldSim = kept.locator('[data-testid="scenario-version-simulation"][data-engine="0.9.0"]');
  const newSim = kept.locator('[data-testid="scenario-version-simulation"][data-engine="0.10.0"]');
  await expect(oldSim).toHaveAttribute("data-active", "true");
  await expect(newSim).toHaveAttribute("data-active", "false");
  await expect(newSim.getByTestId("scenario-simulation-diff")).toContainText(/changed/);
  await expect(kept.getByTestId("scenario-version-map")).toContainText("Richmond Field Station");
  await shot(page, "04-versions-panel");

  // 5. Use the new engine's simulation (roll forward) ...
  await newSim.getByTestId("scenario-simulation-use").click();
  await expect(panel.getByTestId("scenario-versions-notice")).toContainText("now renders the Engine 0.10.0 simulation", { timeout: 60_000 });
  await expect(newSim).toHaveAttribute("data-active", "true", { timeout: 60_000 });
  await expect(oldSim).toHaveAttribute("data-active", "false");
  await shot(page, "05-use-new-engine");

  // 6. ... and roll back: the stored 0.9.0 result, replayed as it was.
  await oldSim.getByTestId("scenario-simulation-use").click();
  await expect(panel.getByTestId("scenario-versions-notice")).toContainText("now renders the Engine 0.9.0 simulation", { timeout: 60_000 });
  await expect(oldSim).toHaveAttribute("data-active", "true", { timeout: 60_000 });
  await shot(page, "06-rolled-back");

  // 7. Compare the two simulations of the version: dual playback.
  await newSim.getByTestId("scenario-simulation-compare").click();
  await expect(compare.getByTestId("scenario-compare-stage")).toBeVisible({ timeout: 120_000 });
  await expect(compare).toContainText("Engine 0.9.0 (active)");
  await expect(compare.getByTestId("scenario-compare-time")).toHaveText("0.0 s");
  await compare.getByTestId("scenario-compare-play").click();
  await expect(compare.getByTestId("scenario-compare-time")).not.toHaveText("0.0 s", { timeout: 10_000 });
  await compare.getByTestId("scenario-compare-scrubber").fill("100");
  await expect(compare.getByTestId("scenario-compare-time")).toHaveText("10.0 s");
  await shot(page, "07-compare-dual-playback");

  // The banner does not come back: the draft moved on with the current engine.
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByTestId("scenario-versions-button")).toBeVisible({ timeout: 10 * 60_000 });
  await page.waitForTimeout(15_000);
  await expect(page.getByTestId("engine-change-banner")).toHaveCount(0);
});
