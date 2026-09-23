/**
 * Driver in the Loop never records or saves a take on its own.
 *
 * The defect (found on rc.74): opening `/dashboard/drive/<doc>` with no input
 * at all recorded a 20 s "Manual drive" while the map was still loading, then
 * saved it into the scenario — bumping draftVersion and REPLACING the actor's
 * authored motion — and routed back to the dataset. The drive session began
 * the take the moment its world ran and saved it the moment the clip ended.
 *
 * These tests hold the fixed contract end to end, against a real host, a real
 * browser and a real map:
 * - with no input, nothing records, nothing is written, the page stays put;
 * - recording starts from an explicit action, and a recorded take reaches the
 *   scenario only through "Keep take" — which, because it replaces motion the
 *   actor already had, first freezes the previous draft as a revision.
 *
 * Environment: a map must load, so either `SIMFORGE_E2E_SEED_DATA_ROOT` (a
 * data root with a completely installed Richmond Field Station, texture tiers
 * included) or `SIMFORGE_E2E_MAPS_FIXTURE_ROOT` (a map corpus a fresh host
 * discovers Richmond in). Set `SIMFORGE_E2E_GPU=1` on a machine with a GPU.
 */

import { createE2eContext, type E2eContext } from "../support/context";
import { E2E_ENV, envValue } from "../support/env";
import { launchBrowserStudio, type StudioSession } from "../support/session";
import { expect, test } from "../support/fixtures";

const TAKE = '[data-testid="drive-take"]';
const CLIP = '[data-testid="drive-clip-countdown"]';
/** A drivable van on a Richmond Field Station road, and the motion it was authored with. */
const ROLE_ID = "vehicle-e2e-drive";
const AUTHORED_MOTION_ID = `simple_timed_route_${ROLE_ID}`;

type DocumentDto = {
  id: string;
  datasetId: string;
  title: string;
  draftVersion: number;
  contentSha256: string;
  content: {
    roles: unknown[];
    choreography: { clipSeconds: number; interactions: { id: string; actor: string; target: { mode?: string } }[] };
  } & Record<string, unknown>;
};

async function launch(context: E2eContext): Promise<StudioSession> {
  const corpus = envValue(E2E_ENV.mapsFixtureRoot);
  if (envValue(E2E_ENV.seedDataRoot) === undefined && corpus === undefined) {
    throw new Error(
      `A drive needs a map that loads. Set ${E2E_ENV.seedDataRoot} to a data root with Richmond Field Station completely `
      + `installed (texture tiers included), or ${E2E_ENV.mapsFixtureRoot} to a map corpus holding it.`,
    );
  }
  return launchBrowserStudio(context, {
    route: "/dashboard/scenario",
    // Revisions are frozen against the host's authoritative simulation.
    worker: true,
    ...(corpus === undefined ? {} : { env: { SIMFORGE_MAPS_CACHE_ROOT: corpus } }),
    async beforeNavigate(page) {
      // Skip the first-run welcome, which a fresh data root otherwise shows.
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("simforge.local-setup.v1", "completed");
        } catch {
          // A storage-less context shows the welcome and the test fails visibly on it.
        }
      });
    },
  });
}

/** A fresh scenario on Richmond with one van whose motion is an authored timed route. */
async function drivableScenario(session: StudioSession): Promise<DocumentDto> {
  const maps = await session.api<{ maps: { mapVersionId: string; sourceMapId: string }[] }>("/api/simforge/maps");
  const richmond = maps.maps.find((map) => map.sourceMapId === "richmond-field-station");
  if (!richmond) {
    throw new Error(`Richmond Field Station is not installed on this host (installed: ${maps.maps.map((map) => map.sourceMapId).join(", ") || "none"}).`);
  }
  const created = await session.api<{ document: DocumentDto }>(
    `/api/simforge/maps/${richmond.mapVersionId}/documents/default`,
    { method: "POST" },
  );
  const base = created.document;
  const content = {
    ...base.content,
    roles: [{
      id: ROLE_ID,
      kind: "scene_absolute",
      label: "Van",
      actor: { class: "van", catalogId: "vehicle.delivery_van", static: false, sensors: [] },
      pose: { position: { x: 47.996, y: 0, z: -338.57 }, headingRad: 0 },
      essentiality: "required",
    }],
    choreography: {
      ...base.content.choreography,
      interactions: [{
        id: AUTHORED_MOTION_ID,
        actor: ROLE_ID,
        trigger: { kind: "at", t: 0 },
        until: { kind: "at", t: base.content.choreography.clipSeconds },
        label: "Simple timed route",
        verb: "route",
        target: { mode: "customTimedRoute", points: [{ timeS: 0, x: 47.996, z: -338.57 }, { timeS: 4, x: 55.378, z: -320 }] },
      }],
    },
  };
  return session.api<DocumentDto>(`/api/simforge/documents/${base.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: base.draftVersion, title: base.title, content }),
  });
}

async function readDocument(session: StudioSession, id: string): Promise<DocumentDto> {
  const body = await session.api<DocumentDto | { document: DocumentDto }>(`/api/simforge/documents/${id}`);
  return "document" in body ? body.document : body;
}

/** Every write the page sends to this document, for the no-write assertion. */
function watchDocumentWrites(session: StudioSession, id: string): string[] {
  const writes: string[] = [];
  session.page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes(`/documents/${id}`)) writes.push(`${request.method()} ${request.url()}`);
  });
  return writes;
}

async function openDrive(session: StudioSession, document: DocumentDto): Promise<void> {
  await session.goto(`/dashboard/drive/${encodeURIComponent(document.id)}?actor=${encodeURIComponent(ROLE_ID)}`);
  await expect(session.page.locator('[data-testid="drive-session"]')).toBeVisible({ timeout: 300_000 });
}

test.describe("Driver in the Loop takes are explicit", () => {
  test.describe.configure({ timeout: 25 * 60_000 });

  test("opening a drive with no input records nothing and writes nothing", async () => {
    const context = await createE2eContext({ name: "drive-no-input" });
    const session = await launch(context);
    try {
      const before = await drivableScenario(session);
      const writes = watchDocumentWrites(session, before.id);
      const openedAt = Date.now();
      await openDrive(session, before);
      const driveUrl = session.page.url();

      // Sample the countdown the whole time: a take that started and was
      // discarded again would still be the defect.
      const clipTexts = new Set<string>();
      const sample = async () => {
        const text = await session.page.locator(CLIP).textContent({ timeout: 1_000 }).catch(() => null);
        if (text) clipTexts.add(text);
      };
      // The map finishes loading and the take arms — and stays armed.
      await expect.poll(async () => {
        await sample();
        return session.page.locator(TAKE).getAttribute("data-take-state", { timeout: 1_000 }).catch(() => null);
      }, { timeout: 600_000, intervals: [1_000] }).toBe("ready");
      // Then well past a whole 20 s clip, with the map interactive, and past
      // 25 s from opening the page.
      const armedAt = Date.now();
      while (Date.now() - armedAt < 30_000 || Date.now() - openedAt < 25_000) {
        await sample();
        await session.page.waitForTimeout(1_000);
      }
      await session.page.screenshot({ path: `${context.evidenceDir}/drive-no-input.png` });

      expect([...clipTexts].filter((text) => text.startsWith("Recording")), "the countdown never showed a recording").toEqual([]);
      await expect(session.page.locator(TAKE)).toHaveAttribute("data-take-state", "ready");
      expect(session.page.url(), "the drive did not navigate away").toBe(driveUrl);
      expect(writes, "no request wrote the document").toEqual([]);
      const after = await readDocument(session, before.id);
      expect(after.draftVersion, "draftVersion unchanged").toBe(before.draftVersion);
      expect(after.contentSha256, "content unchanged").toBe(before.contentSha256);
      expect(after.content.choreography.interactions, "the authored motion is intact").toEqual(before.content.choreography.interactions);
    } finally {
      await session.close();
      await context.dispose();
    }
  });

  test("record, review, keep: the take replaces the motion and the old motion is a revision", async () => {
    const context = await createE2eContext({ name: "drive-record-keep" });
    const session = await launch(context);
    try {
      const before = await drivableScenario(session);
      await openDrive(session, before);
      const take = session.page.locator(TAKE);
      await expect(take).toHaveAttribute("data-take-state", "ready", { timeout: 600_000 });

      await session.page.getByTestId("drive-take-start").click();
      await expect(take).toHaveCount(0);
      await expect(session.page.locator(CLIP)).toContainText("Recording");
      // Drive a little: throttle for three seconds.
      await session.page.keyboard.down("KeyW");
      await session.page.waitForTimeout(3_000);
      await session.page.keyboard.up("KeyW");

      // The clip ends by itself and is held for review, not saved.
      await expect(take).toHaveAttribute("data-take-state", "review", { timeout: 120_000 });
      await expect(session.page.getByTestId("drive-take-detail")).toContainText("replaces Van's current motion");
      await session.page.screenshot({ path: `${context.evidenceDir}/drive-review.png` });
      const reviewed = await readDocument(session, before.id);
      expect(reviewed.draftVersion, "nothing is written before Keep").toBe(before.draftVersion);

      await session.page.getByTestId("drive-take-keep").click();
      await session.page.waitForURL(/\/dashboard\/scenario\?dataset=/, { timeout: 600_000 });

      const after = await readDocument(session, before.id);
      expect(after.draftVersion).toBe(before.draftVersion + 1);
      const motion = after.content.choreography.interactions.filter((interaction) => interaction.actor === ROLE_ID);
      expect(motion.map((interaction) => interaction.target.mode)).toEqual(["manualDrive"]);
      // The motion it replaced is recoverable: the draft as it was before the
      // take is frozen as a revision.
      const { revisions } = await session.api<{ revisions: { id: string; sourceDraftVersion: number; contentSha256: string }[] }>(
        `/api/simforge/documents/${before.id}/revisions`,
      );
      const previous = revisions.find((revision) => revision.sourceDraftVersion === before.draftVersion);
      expect(previous, `a revision of draft ${before.draftVersion}`).toBeDefined();
      expect(previous!.contentSha256, "the revision holds the pre-take content").toBe(before.contentSha256);
    } finally {
      await session.close();
      await context.dispose();
    }
  });
});
