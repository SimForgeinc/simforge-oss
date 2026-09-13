/**
 * The core Studio user flow, end to end, on a genuinely fresh data root:
 *
 *   fresh install -> onboarding gate -> local setup with real map bundles ->
 *   trusted session on /dashboard/scenario -> dataset -> scenario document ->
 *   place a vehicle and a pedestrian -> fit a dash camera -> readiness ->
 *   fixed-step simulation -> playback transport -> reopen the saved scenario
 *
 * and, as a separately gated test, the in-browser render that turns the same
 * authored scenario into artifacts.
 *
 * Everything here drives the product's own accessible UI (`data-testid`, roles,
 * aria labels) and then cross-checks the server's receipts through
 * `studio.api` — the persisted document, the setup row, the render job. The
 * only non-DOM browser surface used is `window.__playback`, the playback
 * controller handle the repository's own verification scripts read
 * (`scripts/verify-live-playback.mjs`); it carries the simulated trace header,
 * which is where the fixed step and the deterministic input hash live. No React
 * internals are inspected.
 *
 * Prerequisites are explicit: both tests need real installed map bundles, and
 * the render test additionally needs a GPU-capable browser. Missing ones fail
 * the test through `requirePrerequisites`, which records a machine-readable
 * `prerequisite-missing` evidence record and annotation instead of quietly
 * passing.
 */
import {
  test,
  expect,
  writeEvidence,
  requirePrerequisites,
  PREREQUISITES,
  installedMapIds,
  linkInstalledMaps,
  type E2eContext,
} from "../support";
import type { Locator, Page } from "@playwright/test";

/** First-run setup, map install and the first map load are all minutes-scale. */
const SETUP_TIMEOUT_MS = 15 * 60_000;
/** Compiling lane topology and the authoring viewer for a real map. */
const EDITOR_READY_TIMEOUT_MS = 6 * 60_000;
/** One simulation of a two-actor scenario, plus bundle upload to the viewer. */
const SIMULATION_TIMEOUT_MS = 4 * 60_000;
/** A browser render walks the whole capture schedule frame by frame. */
const RENDER_TIMEOUT_MS = 20 * 60_000;

type StudioSetupReceipt = {
  completedAt: string | null;
  mode: string | null;
  quality: string | null;
};

type ScenarioSensor = { id: string; type: string; enabled: boolean };
type ScenarioRole = {
  id: string;
  label?: string | null;
  actor: { sensors: readonly ScenarioSensor[] };
};
type ScenarioDocument = {
  id: string;
  title: string;
  datasetId: string;
  draftVersion: number;
  contentSha256: string;
  mapVersionId: string | null;
  latestRevisionId: string | null;
  content: { roles: readonly ScenarioRole[] };
};

/** The control-plane row `GET /api/simforge/render-jobs` returns, as used here. */
type RenderJobSummary = {
  id: string;
  revisionId: string;
  mode: string;
  status: string;
};

/** The subset of `GET /api/simforge/render-jobs/:id/detail` this flow checks. */
type RenderJobDetail = {
  id: string;
  jobMode: string;
  jobState: string;
  rendererEngine: string | null;
  intentSha256: string | null;
  failureCode: string | null;
  artifacts: readonly {
    id: string;
    artifactKind: string;
    artifactState: string;
    byteLength: number;
  }[];
};

/**
 * The playback controller handle the editor publishes on the page while a
 * simulated trace is loaded (see `usePlayback`), declared here so the probe
 * reads a typed value instead of asserting a shape inline.
 */
declare global {
  interface Window {
    __playback?: {
      readonly state: { readonly playing: boolean; readonly time: number };
      readonly bundle: {
        readonly trace: {
          readonly header: { readonly dt: number };
          readonly ticks: { readonly t: ArrayLike<number> };
        };
        readonly instance: { readonly manifest: { readonly inputHash: string } };
        readonly actors: readonly { readonly id: string }[];
      };
    };
  }
}

type PlaybackProbe = {
  playing: boolean;
  time: number;
  /** Trace header fixed step, in seconds. */
  dt: number;
  /** Deterministic digest of everything the simulation was fed. */
  inputHash: string;
  actorIds: readonly string[];
  tickCount: number;
} | null;

/** Read the live playback controller the editor publishes while inspecting. */
async function probePlayback(page: Page): Promise<PlaybackProbe> {
  return await page.evaluate(() => {
    const controller = window.__playback;
    if (!controller) return null;
    return {
      playing: controller.state.playing,
      time: controller.state.time,
      dt: controller.bundle.trace.header.dt,
      inputHash: controller.bundle.instance.manifest.inputHash,
      actorIds: controller.bundle.actors.map((actor) => actor.id),
      tickCount: controller.bundle.trace.ticks.t.length,
    };
  });
}

/** The editor's own readiness flag on the session wrapper. */
async function waitForEditorReady(page: Page): Promise<Locator> {
  const session = page.getByTestId("scenario-editor-session");
  await expect(session).toHaveAttribute("data-editor-ready", "true", {
    timeout: EDITOR_READY_TIMEOUT_MS,
  });
  await expect(page.getByTestId("scenario-editor-surface")).toBeVisible();
  return session;
}

/** Timeline lanes are the visible ledger of which actors the scenario holds. */
function actorLanes(page: Page): Locator {
  return page.locator('[data-testid^="timeline-actor-lane-"]');
}

/**
 * Drop an armed catalog entry onto the road.
 *
 * The ghost only commits where the lane index answers, and the canvas centre of
 * a freshly framed map is not guaranteed to be pavement, so this walks a small
 * deterministic spiral of canvas-relative offsets and stops at the first press
 * that actually adds a lane. Every point is a real pointer move plus a real
 * click on the canvas element — there is no programmatic insertion path here.
 */
async function placeArmedActor(page: Page, expectedLanes: number): Promise<void> {
  const canvas = page.getByTestId("scenario-editor-canvas-region");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box, "the editor canvas must have a layout box").not.toBeNull();
  if (!box) return;

  // Fractions of the canvas box, centre first, then outward. Kept away from the
  // rails (left/right ~14%) and the timeline dock along the bottom.
  const offsets: readonly [number, number][] = [
    [0.5, 0.5],
    [0.5, 0.42],
    [0.42, 0.5],
    [0.58, 0.5],
    [0.5, 0.58],
    [0.4, 0.4],
    [0.6, 0.4],
    [0.4, 0.6],
    [0.6, 0.6],
    [0.5, 0.34],
    [0.34, 0.44],
    [0.66, 0.44],
  ];

  for (const [fx, fy] of offsets) {
    const x = box.x + box.width * fx;
    const y = box.y + box.height * fy;
    await page.mouse.move(x, y, { steps: 8 });
    // The placement ghost is recomputed on pointer move; give the controller a
    // frame to resolve the lane under the cursor before committing.
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.up();
    try {
      await expect(actorLanes(page)).toHaveCount(expectedLanes, { timeout: 4_000 });
      return;
    } catch {
      // Not pavement, or the press landed on an overlay: try the next point.
    }
  }
  throw new Error(
    `placement never committed: still ${await actorLanes(page).count()} actor lanes, wanted ${expectedLanes}`,
  );
}

/** Arm a catalog tool and place one entry from it. */
async function placeFromCatalog(
  page: Page,
  tool: "vehicles" | "pedestrians",
  expectedLanes: number,
): Promise<void> {
  await page.getByTestId(`tool-${tool}`).click();
  await expect(page.getByTestId("catalog-drawer")).toBeVisible();
  if (tool === "vehicles") {
    // "Random" arms a real catalog vehicle rather than pinning the flow to one
    // asset id that the catalog may re-slot.
    await page.getByRole("button", { name: "Add random car" }).click();
  } else {
    // Each tile's own action element carries `Place <label>`; the first visible
    // one is the catalog's default-ranked entry for the active tool.
    const tile = page.locator('[data-testid^="catalog-action-"]').first();
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await tile.click();
  }
  await placeArmedActor(page, expectedLanes);
  // Leave the catalog closed so it cannot swallow later canvas presses.
  const close = page.getByTestId("catalog-close");
  if (await close.isVisible()) await close.click();
}

/**
 * Walk a fresh data root through onboarding into the scenario workspace.
 *
 * The real map bundles are symlinked into this test's isolated cache first, so
 * the install the onboarding screen starts resolves against the local corpus
 * instead of downloading gigabytes from a registry.
 */
async function completeFirstRunSetup(
  context: E2eContext,
  studio: { page: Page; goto: (path: string) => Promise<unknown>; api: <T>(path: string) => Promise<T> },
): Promise<StudioSetupReceipt & { linkedMaps: readonly string[] }> {
  const { page } = studio;

  const corpus = await installedMapIds();
  expect(corpus.length, "the configured map corpus must hold at least one installed map")
    .toBeGreaterThan(0);
  const linkedMaps = await linkInstalledMaps(context, corpus);

  await studio.goto("/dashboard/scenario");
  await page.waitForURL(/\/onboarding\/welcome/, { timeout: 120_000 });
  await expect(page.getByTestId("onboarding-welcome")).toBeVisible();
  const before = await studio.api<StudioSetupReceipt>("/api/simforge/host/setup");
  expect(before.completedAt, "a fresh data root must not claim setup").toBeNull();

  await page.getByTestId("onboarding-continue-locally").click();
  await expect(page.getByTestId("onboarding-maps")).toBeVisible({ timeout: 120_000 });

  const cards = page.getByTestId("onboarding-map-card");
  await expect(cards.first()).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("onboarding-quality-option").first().click();

  await page.getByTestId("onboarding-download").click();
  await expect(page.getByTestId("onboarding-preparation-row").first()).toBeVisible({
    timeout: 120_000,
  });
  // Setup completes by replacing the route with the map gallery.
  await page.waitForURL(/\/dashboard\/map-assets/, { timeout: SETUP_TIMEOUT_MS });

  const after = await studio.api<StudioSetupReceipt>("/api/simforge/host/setup");
  expect(after.completedAt, "setup must be recorded server-side").not.toBeNull();
  expect(after.mode).toBe("local");
  expect(after.quality).not.toBeNull();
  return { ...after, linkedMaps };
}

/** Create a dataset through the rail dialog and return its visible name. */
async function createDataset(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("scenario-dataset-index")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("scenario-new-dataset").first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "New dataset" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Dataset name").fill(name);
  await dialog.getByRole("button", { name: "Create dataset" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId("scenario-dataset-rail").getByText(name, { exact: false }))
    .toBeVisible({ timeout: 60_000 });
}

/** Open the dataset, add one scenario on the first offered map, land in the editor. */
async function createScenario(page: Page, datasetName: string): Promise<void> {
  await page.getByTestId("scenario-dataset-rail").getByText(datasetName, { exact: false }).click();
  await expect(page.getByTestId("scenario-document-index")).toBeVisible({ timeout: 120_000 });

  await page.getByRole("button", { name: "Add scenario" }).click();
  await page.getByRole("menuitem", { name: "New Scenario" }).click();

  const picker = page.getByRole("dialog", { name: "Select map" });
  await expect(picker).toBeVisible({ timeout: 60_000 });
  await picker.getByRole("button", { name: /^(Select Map|Use This Map)$/ }).first().click();

  await page.waitForURL(/[?&]document=/, { timeout: 120_000 });
  await waitForEditorReady(page);
}

test.describe("core studio flow", () => {
  test("fresh setup, authoring, simulation, playback and reopen", async ({ e2e, studio }, testInfo) => {
    test.setTimeout(SETUP_TIMEOUT_MS + EDITOR_READY_TIMEOUT_MS + SIMULATION_TIMEOUT_MS + 120_000);
    await requirePrerequisites(testInfo, [PREREQUISITES.realMaps]);

    const { page } = studio;
    const datasetName = `E2E Core ${e2e.id}`;
    const evidence: Record<string, unknown> = { runId: e2e.id, mode: studio.mode };

    await test.step("a fresh install gates the dashboard into onboarding", async () => {
      evidence.setup = await completeFirstRunSetup(e2e, studio);
    });

    await test.step("the trusted session reaches the scenario workspace", async () => {
      await studio.goto("/dashboard/scenario");
      await expect(page.getByTestId("scenario-dataset-index")).toBeVisible({ timeout: 120_000 });
      // The gate un-hides only for an installation that finished setup.
      await expect(page.getByTestId("onboarding-gate-content")).not.toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(new URL(page.url()).pathname).toBe("/dashboard/scenario");
    });

    await test.step("create a dataset and a scenario on a real map", async () => {
      await createDataset(page, datasetName);
      await createScenario(page, datasetName);
    });

    const documentId = new URL(page.url()).searchParams.get("document");
    expect(documentId, "the editor URL must carry the document id").toBeTruthy();
    if (!documentId) return;

    await test.step("author a vehicle and a pedestrian", async () => {
      await expect(actorLanes(page)).toHaveCount(0);
      await placeFromCatalog(page, "vehicles", 1);
      await placeFromCatalog(page, "pedestrians", 2);

      await expect
        .poll(
          async () => {
            const draft = await studio.api<ScenarioDocument>(
              `/api/simforge/documents/${documentId}`,
            );
            return draft.content.roles.length;
          },
          { timeout: 60_000, message: "the draft must persist both authored actors" },
        )
        .toBe(2);

      const document = await studio.api<ScenarioDocument>(`/api/simforge/documents/${documentId}`);
      expect(document.datasetId).toBeTruthy();
      expect(document.mapVersionId, "an authored scenario is map-bound").toBeTruthy();
      expect(document.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(document.draftVersion).toBeGreaterThan(1);
      evidence.authoredRoles = document.content.roles.map((role) => role.id);
      evidence.contentSha256 = document.contentSha256;
    });

    await test.step("fit a dash camera to the vehicle", async () => {
      const firstLane = actorLanes(page).first();
      const laneTestId = await firstLane.getAttribute("data-testid");
      const actorId = laneTestId?.replace("timeline-actor-lane-", "") ?? "";
      expect(actorId).not.toBe("");
      await page.getByTestId(`timeline-actor-identity-${actorId}`).click();

      await expect(page.getByTestId("scenario-actor-details-panel")).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole("button", { name: "Add dash camera" }).click();

      // The rail switches from the "add a camera" prompt to a live sensor row.
      await expect(page.getByRole("switch", { name: /enabled$/ }).first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByTestId("actor-records-scenario")).toBeVisible();

      await expect
        .poll(
          async () => {
            const document = await studio.api<ScenarioDocument>(
              `/api/simforge/documents/${documentId}`,
            );
            return document.content.roles.find((role) => role.id === actorId)?.actor.sensors.length ?? 0;
          },
          { timeout: 60_000, message: "the dash camera must persist on the authored role" },
        )
        .toBeGreaterThan(0);

      const document = await studio.api<ScenarioDocument>(`/api/simforge/documents/${documentId}`);
      const sensors = document.content.roles.find((role) => role.id === actorId)?.actor.sensors ?? [];
      expect(sensors.some((sensor) => sensor.enabled)).toBe(true);
      evidence.sensors = sensors.map((sensor) => ({ id: sensor.id, type: sensor.type }));
    });

    await test.step("readiness reports the authored scenario", async () => {
      const readiness = page.getByTestId("scenario-readiness-button");
      await expect(readiness).toBeVisible({ timeout: SIMULATION_TIMEOUT_MS });
      const label = await readiness.getAttribute("aria-label");
      expect(label, "readiness must state a verdict").toMatch(/^Scenario readiness: /);

      await readiness.click();
      const drawer = page.getByTestId("scenario-readiness-drawer");
      await expect(drawer).toBeVisible();
      await expect(page.getByTestId("scenario-readiness-realism")).toBeVisible();

      const issues = page.getByTestId("scenario-readiness-issue");
      const issueCount = await issues.count();
      if (/Ready$/.test(label ?? "")) {
        expect(issueCount).toBe(0);
      } else {
        // A warning verdict must name what it is warning about.
        expect(issueCount).toBeGreaterThan(0);
      }
      evidence.readiness = { label, issueCount };
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    });

    let simulation: PlaybackProbe = null;
    await test.step("run the fixed-step simulation and drive playback", async () => {
      const play = page.getByRole("button", { name: "Play scenario" });
      // The transport unlocks only once a simulated trace exists for the draft.
      await expect(play).toBeEnabled({ timeout: SIMULATION_TIMEOUT_MS });
      await play.click();

      await expect
        .poll(async () => (await probePlayback(page))?.playing ?? false, {
          timeout: 60_000,
          message: "the transport must start the trace-driven playback",
        })
        .toBe(true);

      const started = await probePlayback(page);
      expect(started).not.toBeNull();
      expect(started?.dt, "the trace must carry a positive fixed step").toBeGreaterThan(0);
      expect(started?.tickCount, "a fixed-step trace has sampled ticks").toBeGreaterThan(1);
      expect(started?.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(started?.actorIds.length).toBe(2);

      await page.getByRole("button", { name: "Stop scenario" }).click();
      await expect
        .poll(async () => (await probePlayback(page))?.playing ?? true, { timeout: 30_000 })
        .toBe(false);

      const paused = await probePlayback(page);
      expect(paused?.time ?? 0).toBeGreaterThan(started?.time ?? 0);

      await page.getByRole("button", { name: "Reset scenario" }).click();
      await expect
        .poll(async () => (await probePlayback(page))?.time ?? -1, { timeout: 30_000 })
        .toBeLessThanOrEqual(paused?.time ?? 0);

      simulation = paused;
      evidence.simulation = {
        fixedStepSeconds: paused?.dt,
        inputHash: paused?.inputHash,
        tickCount: paused?.tickCount,
        actorIds: paused?.actorIds,
        pausedAtSeconds: paused?.time,
      };
      await testInfo.attach("playback-after-transport.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

    await test.step("reopening the saved scenario restores it deterministically", async () => {
      const datasetId = new URL(page.url()).searchParams.get("dataset");
      expect(datasetId).toBeTruthy();

      // A genuinely new navigation, not a client-side route change.
      await studio.goto(`/dashboard/scenario?dataset=${datasetId}&document=${documentId}`);
      await waitForEditorReady(page);
      await expect(actorLanes(page)).toHaveCount(2, { timeout: EDITOR_READY_TIMEOUT_MS });

      const reopened = await studio.api<ScenarioDocument>(`/api/simforge/documents/${documentId}`);
      expect(reopened.content.roles.map((role) => role.id).sort()).toEqual(
        (evidence.authoredRoles as string[]).slice().sort(),
      );
      expect(reopened.contentSha256).toBe(evidence.contentSha256);
      expect(
        reopened.content.roles.reduce((total, role) => total + role.actor.sensors.length, 0),
      ).toBeGreaterThan(0);

      // Same inputs, same simulation: the reopened draft must hash identically.
      const play = page.getByRole("button", { name: "Play scenario" });
      await expect(play).toBeEnabled({ timeout: SIMULATION_TIMEOUT_MS });
      const resimulated = await probePlayback(page);
      expect(resimulated?.inputHash).toBe(simulation?.inputHash);
      expect(resimulated?.dt).toBe(simulation?.dt);
      evidence.reopen = {
        roles: reopened.content.roles.length,
        contentSha256: reopened.contentSha256,
        inputHash: resimulated?.inputHash,
      };
    });

    await writeEvidence(testInfo, "core-studio-flow", evidence);
  });

  test("in-browser render produces verifiable artifacts", async ({ e2e, studio }, testInfo) => {
    test.setTimeout(SETUP_TIMEOUT_MS + EDITOR_READY_TIMEOUT_MS + RENDER_TIMEOUT_MS + 120_000);
    await requirePrerequisites(testInfo, [PREREQUISITES.realMaps, PREREQUISITES.gpu]);

    const { page } = studio;
    const datasetName = `E2E Render ${e2e.id}`;
    const evidence: Record<string, unknown> = { runId: e2e.id, mode: studio.mode };

    await test.step("set up, author one recording vehicle", async () => {
      evidence.setup = await completeFirstRunSetup(e2e, studio);
      await studio.goto("/dashboard/scenario");
      await createDataset(page, datasetName);
      await createScenario(page, datasetName);
      await placeFromCatalog(page, "vehicles", 1);

      const laneTestId = await actorLanes(page).first().getAttribute("data-testid");
      const actorId = laneTestId?.replace("timeline-actor-lane-", "") ?? "";
      expect(actorId).not.toBe("");
      await page.getByTestId(`timeline-actor-identity-${actorId}`).click();
      await expect(page.getByTestId("scenario-actor-details-panel")).toBeVisible({
        timeout: 60_000,
      });
      // A render needs at least one camera to record from.
      await page.getByRole("button", { name: "Add dash camera" }).click();
      await expect(page.getByRole("switch", { name: /enabled$/ }).first()).toBeVisible({
        timeout: 60_000,
      });
      evidence.actorId = actorId;
    });

    const documentId = new URL(page.url()).searchParams.get("document");
    expect(documentId).toBeTruthy();
    if (!documentId) return;

    await test.step("configure the browser engine and run the render", async () => {
      // The render workspace lives beside the scenario list, not inside the
      // editor: leave the editor, then open this scenario's render pane.
      await page.getByRole("button", { name: "Exit editor" }).click();
      await expect(page.getByTestId("scenario-document-index")).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: /^Render / }).first().click();
      await expect(page.getByTestId("scenario-dataset-render-pane")).toBeVisible({
        timeout: 120_000,
      });

      await page.getByTestId("new-render-button").click();
      await expect(page.getByTestId("render-config-panel")).toBeVisible({ timeout: 120_000 });

      // The engine step is a radiogroup of host-offered renderers; a host that
      // does not offer the browser lane hides the card, and this fails loudly.
      const browserEngine = page.getByTestId("render-backend-browser");
      await expect(browserEngine).toBeVisible({ timeout: 120_000 });
      await browserEngine.click();
      await page.getByTestId("render-wizard-next").click();

      // Cameras: record RGB from every fitted sensor, otherwise the wizard has
      // nothing to capture and the run step stays closed.
      await expect(page.getByTestId("recording-sensor-matrix")).toBeVisible({ timeout: 120_000 });
      await page.getByTestId("sensor-modality-column-rgb").click();

      // Walk the remaining steps; each Next is gated on a valid step.
      const next = page.getByTestId("render-wizard-next");
      const run = page.getByTestId("render-run-button");
      for (let step = 0; step < 6 && !(await run.isVisible()); step += 1) {
        await expect(next).toBeEnabled({ timeout: 120_000 });
        await next.click();
      }
      await expect(run).toBeEnabled({ timeout: 120_000 });
      await run.click();
    });

    await test.step("the render reports progress and lands artifacts", async () => {
      const artifacts = page.getByTestId("render-progress-artifacts");
      await expect(page.getByTestId("render-progress-percent")).toBeVisible({
        timeout: RENDER_TIMEOUT_MS,
      });
      await expect(artifacts).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
      await expect(artifacts.locator("li").first()).toBeVisible();
      await expect(page.getByTestId("render-progress-failure")).toBeHidden();

      const rows = await artifacts.locator("li").allInnerTexts();
      expect(rows.length).toBeGreaterThan(0);
      // Every artifact row states a byte size and a state, not a placeholder.
      for (const row of rows) expect(row).toMatch(/\d/);
      evidence.artifactRows = rows;

      await testInfo.attach("render-progress.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

    await test.step("the render job receipt matches the authored scenario", async () => {
      // Submitting a render freezes the draft into a revision; that revision id
      // is the only join between this document and the control-plane job row.
      const document = await studio.api<ScenarioDocument>(
        `/api/simforge/documents/${documentId}`,
      );
      expect(document.latestRevisionId, "a submitted render freezes a revision").toBeTruthy();

      const list = await studio.api<{ renderJobs: readonly RenderJobSummary[] }>(
        "/api/simforge/render-jobs",
      );
      const job = list.renderJobs.find(
        (candidate) => candidate.revisionId === document.latestRevisionId,
      );
      expect(job, "the host must list a render job for this scenario's revision").toBeTruthy();
      if (!job) return;

      const detail = await studio.api<RenderJobDetail>(
        `/api/simforge/render-jobs/${job.id}/detail`,
      );
      expect(detail.id).toBe(job.id);
      // Mirrors the product's own engine derivation: the browser lane records
      // under `job_mode = browser_render` and may leave the column null.
      const engine = detail.rendererEngine ?? (detail.jobMode === "browser_render" ? "browser" : "native");
      expect(engine).toBe("browser");
      expect(detail.intentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(detail.artifacts.length).toBeGreaterThan(0);
      for (const artifact of detail.artifacts) {
        expect(artifact.byteLength, `${artifact.id} must carry bytes`).toBeGreaterThan(0);
        expect(artifact.artifactState).not.toBe("failed");
      }
      expect(detail.failureCode).toBeNull();
      evidence.render = {
        jobId: job.id,
        revisionId: job.revisionId,
        engine,
        intentSha256: detail.intentSha256,
        artifacts: detail.artifacts.map((artifact) => ({
          kind: artifact.artifactKind,
          state: artifact.artifactState,
          byteLength: artifact.byteLength,
        })),
      };
    });

    await writeEvidence(testInfo, "core-studio-browser-render", evidence);
  });
});
