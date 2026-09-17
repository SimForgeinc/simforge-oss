#!/usr/bin/env node
// Native viewport acceptance harness.
//
// One harness for the whole native stack, because the failures worth catching
// are boundary failures: identity that never reaches Rust, a command the
// renderer silently ignores, a pick that resolves empty because a field was
// projected away, a readiness state with no producer. Each check drives the
// REAL pieces — the shipped `NativeViewportProcess` host wrapper and the
// shipped `NativeProcessRenderer` editor adapter — against a real canonical
// map on a real GPU.
//
// The Electron main process is stood in for by `hostIdentity` below: it
// resolves the map root from identity exactly as `studio/desktop/main.mjs`
// does, so the renderer half of the boundary is exercised unchanged.
//
// Usage:
//   node scripts/verify-native-viewport.mjs [--checks=identity,protocol,pick,readiness,progressive]
//                                           [--map=richmond-field-station] [--json=<path>]
//   node scripts/verify-native-viewport.mjs --checks=memory-census
//                                           [--census-maps=a,b] [--census-json=<path>]
//                                           [--census-tolerance=0.1] [--census-sample-ms=150]
// Environment:
//   SIMFORGE_MAPS_CACHE_ROOT  cache root holding `.corpus/<sourceMapId>`
//                             (default: $XDG_DATA_HOME/simforge/maps)
//   SIMFORGE_NATIVE_VIEWPORT  viewport binary (default: renderer/target/release/...)

import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { BENCH_DWELL_MS, BENCH_VIEWPORT_ARGS, cameraPath } from "./bench/interactive-viewport/camera-path.mjs";
import { register } from "tsx/esm/api";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const { NativeProcessRenderer } = await import("../packages/viewer/src/native-process-renderer.ts");
const { createMapServer } = await import("../packages/viewer/dev/serve.mjs");
const { NativeViewportProcess } = await import("../studio/desktop/native-viewport.mjs");

const root = resolve(import.meta.dirname, "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const [name, ...value] = arg.replace(/^--/, "").split("=");
  return [name, value.join("=") || "true"];
}));
const binary = process.env.SIMFORGE_NATIVE_VIEWPORT ?? join(root, "renderer/target/release/simforge-native-viewport");
// Same resolution as `studio/scripts/seed.ts`: one map cache per machine, at
// the XDG data path. Override only to point at a variant of that root.
const cacheRoot =
  process.env.SIMFORGE_MAPS_CACHE_ROOT ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "simforge/maps");
// The parity check hosts the editor surface itself: vite for the page, the
// viewer's own static server for the map bytes. Ports are the harness's own,
// never a running Studio's.
const parityVitePort = Number(args.get("parity-vite-port") ?? 5178);
const parityMapPort = Number(args.get("parity-map-port") ?? 8792);
const viewerRequire = createRequire(join(root, "packages/viewer/package.json"));
const chromeBinary = process.env.SIMFORGE_CHROMIUM
  ?? join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
// Where the parity check writes its display grabs. Absent: no capture.
const shotDir = args.get("screenshots") ?? null;
await access(binary);

// `memory-census` is not in the default suite: it runs two maps to `complete`
// twice over and polls the driver throughout, so it is asked for by name.
const CHECKS = ["identity", "protocol", "pick", "readiness", "progressive", "parity", "memory-census"];
const DEFAULT_CHECKS = CHECKS.filter((name) => name !== "memory-census");
const selected = (args.get("checks") ?? DEFAULT_CHECKS.join(",")).split(",").filter((name) => CHECKS.includes(name));
const sourceMapId = args.get("map") ?? "richmond-field-station";
// How long `complete` may take. Lowerable so a scheduler that never settles
// reports in minutes instead of holding the suite for twenty of them.
const completeTimeoutMs = Number(args.get("complete-timeout-ms") ?? 1_200_000);
// `--map` selects the map for every check, progressive included; the largest
// canonical map stays the default so the unflagged suite keeps stressing it.
// Without this, `--checks=progressive --map=X` silently measured a different
// map than the one named on the command line.
const progressiveMapId = args.get("progressive-map") ?? args.get("map") ?? "san-ramon-phase-2";
// The census runs the worst absolute gap and the worst ratio by default:
// san-ramon-phase-2 (2 GiB accounted inside 6.6 GB of driver memory) and
// el-camino-road (213 MB accounted inside 2.36 GB, so mostly fixed overhead).
const censusMapIds = (args.get("census-maps") ?? "san-ramon-phase-2,el-camino-road").split(",").filter(Boolean);
const censusJsonPath = args.get("census-json") ?? null;
const censusSampleMs = Number(args.get("census-sample-ms") ?? 150);
// Fraction of the driver's peak the census is allowed to leave unexplained.
const censusTolerance = Number(args.get("census-tolerance") ?? 0.1);
const READINESS = ["manifest-ready", "coarse-ready", "interactive", "complete", "device-lost", "error"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The Electron main process's job: identity in, verified map root out. */
async function hostIdentity(id) {
  const mapRoot = join(cacheRoot, ".corpus", id);
  const release = JSON.parse(await readFile(join(mapRoot, ".map-release.json"), "utf8"));
  return {
    mapRoot,
    mapVersionId: `${release.name}@${release.version}`,
    releaseDigest: release.releaseDigest,
    canonicalDigest: release.canonicalDigest,
  };
}

let displaySeq = 0;

/**
 * A viewport process on its own Xvfb display, plus its event log. A real
 * windowed GPU run: `--headless` would skip the swapchain, which is where
 * pipeline compilation and device loss actually live.
 */
async function launch(mapRoot, extra = []) {
  const display = `:${91 + (displaySeq++ % 8)}`;
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], { stdio: "ignore" });
  await sleep(700);
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = display;
  const viewport = new NativeViewportProcess({ executable: binary, mapRoot, args: extra });
  const events = [];
  const logs = [];
  viewport.onEvent((event) => events.push(event));
  const started = viewport.start();
  viewport.stderr?.on("data", (chunk) => logs.push(String(chunk)));
  if (previousDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay;
  return {
    viewport,
    events,
    logs,
    started,
    stop() {
      viewport.stop();
      xvfb.kill("SIGTERM");
    },
  };
}

/** Poll a live event log until `predicate` matches one of its entries. */
async function waitFor(events, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}; saw: ${events.map((event) => event.event).join(",") || "nothing"}`);
    }
    await sleep(25);
  }
}

const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${check} ${JSON.stringify(detail)}`);
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// identity: the release the host asks for is the release Rust proves against
// the bytes, and a digest that does not match them is rejected, not echoed.
// ---------------------------------------------------------------------------
async function checkIdentity() {
  const identity = await hostIdentity(sourceMapId);
  const good = await launch(identity.mapRoot);
  try {
    await good.started;
    good.viewport.loadMap(identity);
    const ready = await waitFor(good.events, (event) => event.event === "manifest-ready", 60_000, "manifest-ready");
    const matches = ready.releaseDigest === identity.releaseDigest
      && ready.canonicalDigest === identity.canonicalDigest
      && ready.mapVersionId === identity.mapVersionId
      && Boolean(ready.verified?.includes("master.gltf"));
    record("identity.accepts-verified-release", matches, {
      mapRoot: identity.mapRoot,
      mapVersionId: ready.mapVersionId,
      releaseDigest: ready.releaseDigest,
      canonicalDigest: ready.canonicalDigest,
      verified: ready.verified,
      sizeCheckedMembers: ready.sizeCheckedMembers,
    });
  } finally {
    good.stop();
  }

  // Same bytes, one hex digit changed: the manifest on disk must win.
  const corrupted = `${identity.releaseDigest.slice(0, 63)}${identity.releaseDigest.endsWith("0") ? "1" : "0"}`;
  const bad = await launch(identity.mapRoot);
  try {
    await bad.started;
    bad.viewport.loadMap({ ...identity, releaseDigest: corrupted });
    const failure = await waitFor(bad.events, (event) => event.event === "error", 60_000, "error");
    await sleep(1500);
    const loadedAnyway = bad.events.some((event) => ["coarse-ready", "interactive", "complete"].includes(event.event));
    record("identity.rejects-corrupted-digest", failure.code === "release_digest_mismatch" && !loadedAnyway, {
      requested: corrupted,
      code: failure.code,
      message: failure.message,
      loadedAnyway,
    });
  } finally {
    bad.stop();
  }
}

// ---------------------------------------------------------------------------
// protocol: every command PROTOCOL.md documents for v1 has an arm, anything
// else produces an error event, and the v2 arm says so by name.
// ---------------------------------------------------------------------------
async function checkProtocol() {
  const identity = await hostIdentity(sourceMapId);
  const documented = (await readFile(join(root, "renderer/viewport/PROTOCOL.md"), "utf8"))
    .split("## Host → viewport commands")[1]
    .split("```")[1]
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  // `--memory-census` because the documented `memory-census` command
  // declares that flag as its precondition, and this check's claim is that
  // every documented command is accepted when its contract is satisfied —
  // not that the diagnostics sampler runs in every session.
  const run = await launch(identity.mapRoot, ["--memory-census"]);
  try {
    await run.started;
    run.viewport.loadMap(identity);
    await waitFor(run.events, (event) => event.event === "interactive", 180_000, "interactive");
    const before = run.events.length;
    let sent = 0;
    for (const command of documented) {
      if (command.command === "quit" || command.command === "load-map" || command.command === "debug-device-lost") continue;
      // The documented pointer-ray example is an illustration, not a ray into
      // this map; aim it down the scene's own vertical axis.
      run.viewport.send(command.command === "pointer-ray" ? { ...command, origin: [0, 500, 0], direction: [0, -1, 0] } : command);
      sent += 1;
    }
    await sleep(2000);
    const answered = run.events.slice(before);
    const errors = answered.filter((event) => event.event === "error");
    record("protocol.documented-commands-accepted", errors.length === 0, {
      sent,
      events: answered.map((event) => event.event),
      errors: errors.map((event) => `${event.code}: ${event.message}`),
    });

    const unknownAt = run.events.length;
    run.viewport.send({ command: "teleport", to: [0, 0, 0] });
    const unknown = await waitFor(
      run.events,
      (event, index) => index >= unknownAt && event.event === "error",
      10_000,
      "error event for an unknown command",
    );
    record("protocol.unknown-command-errors", unknown.code === "unknown_command", { code: unknown.code, message: unknown.message });

    const gizmoAt = run.events.length;
    run.viewport.send({ command: "gizmo", operation: "translate", ids: [], delta: [0, 0, 0] });
    const gizmo = await waitFor(
      run.events,
      (event, index) => index >= gizmoAt && event.event === "error",
      10_000,
      "error event for the v2 gizmo command",
    );
    record("protocol.v2-command-declared", gizmo.code === "command_not_implemented", { code: gizmo.code, message: gizmo.message });
  } finally {
    run.stop();
  }
}

// ---------------------------------------------------------------------------
// pick: a positive hit on loaded geometry, resolved through the editor's own
// adapter promise, with a stable id, a distance and a world point.
// ---------------------------------------------------------------------------
async function checkPick() {
  const identity = await hostIdentity(sourceMapId);
  const run = await launch(identity.mapRoot);
  try {
    await run.started;
    // The editor adapter, unmodified. `loadMap` carries identity only; the
    // map root is attached here, host-side, exactly as Electron main does.
    const renderer = new NativeProcessRenderer({
      onEvent: (listener) => run.viewport.onEvent(listener),
      start: async () => ({ ok: true }),
      send: (command) => run.viewport.send(command.command === "load-map" ? { ...command, mapRoot: identity.mapRoot } : command),
      stop: () => {},
    });
    await renderer.loadMap({ mapVersionId: identity.mapVersionId, releaseDigest: identity.releaseDigest });
    await waitFor(run.events, (event) => event.event === "interactive", 180_000, "interactive");
    await waitFor(run.events, (event) => event.event === "camera-state", 20_000, "camera-state");
    // Look down at the scene origin from above: the map's largest surfaces
    // sit around it, so a centre-screen ray has to cross geometry.
    renderer.applyCamera({ kind: "set-pose", pose: { position: [40, 260, 40], target: [0, 0, 0] } });
    await sleep(400);
    const state = renderer.cameraState();
    const result = await Promise.race([
      renderer.pick({ ndc: { x: 0, y: 0 }, maxHits: 8 }),
      sleep(20_000).then(() => { throw new Error("pick promise never settled"); }),
    ]);
    const hit = result.hits[0];
    const ok = Boolean(hit && typeof hit.id === "string" && hit.id.length > 0 && Number.isFinite(hit.distanceM) && hit.distanceM > 0
      && Array.isArray(hit.point) && hit.point.every(Number.isFinite));
    record("pick.positive-hit-through-adapter", ok, {
      hits: result.hits.length,
      id: hit?.id ?? null,
      layer: hit?.layer ?? null,
      distanceM: hit?.distanceM ?? null,
      point: hit?.point ?? null,
      cameraFovYDeg: state?.intrinsics.fovYDeg ?? null,
      cameraAspect: state?.intrinsics.aspect ?? null,
    });
  } finally {
    run.stop();
  }
}

// ---------------------------------------------------------------------------
// readiness: every state, including a forced device loss and the recovery
// that follows it.
// ---------------------------------------------------------------------------
async function checkReadiness() {
  const identity = await hostIdentity(sourceMapId);
  const run = await launch(identity.mapRoot);
  try {
    await run.started;
    run.viewport.loadMap(identity);
    await waitFor(run.events, (event) => event.event === "complete", 300_000, "complete");
    const lossAt = run.events.length;
    run.viewport.send({ command: "debug-device-lost", reason: "acceptance fault injection" });
    const lost = await waitFor(run.events, (event, index) => index >= lossAt && event.event === "device-lost", 30_000, "device-lost");
    const recovered = await waitFor(
      run.events,
      (event, index) => index > lossAt && event.event === "interactive",
      240_000,
      "interactive after device loss",
    );
    const order = run.events.filter((event) => READINESS.includes(event.event)).map((event) => event.event);
    // `starting` is the process's own first state; it is only emitted when no
    // map identity is on argv, which is exactly how the shell launches it.
    const states = new Set(["starting", ...order]);
    record("readiness.every-state-observed", ["manifest-ready", "coarse-ready", "interactive", "complete", "device-lost"].every((state) => states.has(state)), {
      order: ["starting", ...order],
    });
    record("readiness.recovers-after-device-loss", true, {
      reason: lost.reason,
      recoverable: lost.recoverable,
      recoveredInteractiveMs: recovered.elapsedMs,
      afterLoss: run.events.slice(lossAt).filter((event) => READINESS.includes(event.event)).map((event) => event.event),
    });
  } finally {
    run.stop();
  }
}

// ---------------------------------------------------------------------------
// progressive: the largest canonical map must be interactive on coarse
// geometry quickly, then stream to complete inside its byte budget.
// ---------------------------------------------------------------------------
async function checkProgressive() {
  const identity = await hostIdentity(progressiveMapId);
  const run = await launch(identity.mapRoot);
  try {
    await run.started;
    run.viewport.loadMap(identity);
    const coarse = await waitFor(run.events, (event) => event.event === "coarse-ready", 180_000, "coarse-ready");
    const interactive = await waitFor(run.events, (event) => event.event === "interactive", 180_000, "interactive");
    const complete = await waitFor(run.events, (event) => event.event === "complete", completeTimeoutMs, "complete");
    // Two independent claims, both required: the editor becomes interactive on
    // coarse geometry quickly, and streaming to `complete` never exceeds the
    // budget it was given. A run that completes by overshooting the budget is
    // a failure, not a pass.
    const withinBudget = complete.peakResidentBytes <= complete.budgetBytes;
    record("progressive.interactive-on-coarse-geometry", interactive.elapsedMs < 10_000 && withinBudget, {
      withinBudget,
      map: identity.mapVersionId,
      coarseReadyMs: coarse.elapsedMs,
      coarseNodes: coarse.nodes,
      interactiveMs: interactive.elapsedMs,
      interactiveResidentBytes: interactive.residentBytes,
      completeMs: complete.elapsedMs,
      peakResidentBytes: complete.peakResidentBytes,
      budgetBytes: complete.budgetBytes,
      budgetSkippedNodes: complete.budgetSkippedNodes,
      residentNodes: complete.residentNodes,
    });
  } finally {
    run.stop();
  }
}

// ---------------------------------------------------------------------------
// parity: the same editor interactions under `rendererMode=web` and
// `rendererMode=native`, plus the guarantee that explicit `native` never
// quietly becomes WebGL.
//
// The surface driven here is the shipped `CityView` component in the
// `packages/viewer/dev/editor.html` harness page, with the shipped
// `ThreeRendererAdapter` on the web side and the shipped
// `NativeProcessRenderer` over a real viewport process on the native side.
// The page reaches that process through the same forwarding shape Electron
// uses, so "native" here means the actual out-of-process renderer.
// ---------------------------------------------------------------------------
async function checkParity() {
  const identity = await hostIdentity(sourceMapId);
  const bundle = join(cacheRoot, "map-bundles", sourceMapId);
  await access(join(bundle, "3d/manifest.json"));

  const mapServer = createMapServer(join(cacheRoot, "map-bundles"));
  await new Promise((done) => mapServer.listen(parityMapPort, done));
  const { createServer } = await import(viewerRequire.resolve("vite"));
  const vite = await createServer({
    configFile: join(root, "packages/viewer/dev/vite.config.ts"),
    server: { port: parityVitePort, strictPort: true },
    logLevel: "warn",
  });
  await vite.listen();
  const browser = await chromium.launch({
    executablePath: chromeBinary,
    headless: false,
    args: [
      // ANGLE over Vulkan: under Xvfb the GLX path is Mesa llvmpipe and the
      // plain EGL path is SwiftShader, and a software rasteriser cannot tell
      // us whether the real WebGL backend works.
      "--use-gl=angle",
      "--use-angle=vulkan",
      "--enable-features=Vulkan",
      "--ignore-gpu-blocklist",
    ],
  });

  /**
   * One editor session in one renderer mode.
   *
   * `viewportBinary` is what makes the negative case real: pointing the host
   * at a binary that cannot run is a native backend that genuinely fails,
   * not a mocked failure.
   */
  async function session(mode, { viewportBinary = binary } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // A dev server answers a missing module with index.html, which reaches the
    // page as "Unexpected identifier 'html'". The URL is the only thing that
    // identifies which asset went missing, so keep it.
    page.on("response", (response) => {
      const url = response.url();
      if (response.status() >= 400) pageErrors.push(`http ${response.status()} ${url}`);
      if (!/\.(js|wasm)(\?|$)/.test(url)) return;
      const type = response.headers()["content-type"] ?? "";
      if (type.includes("html")) pageErrors.push(`html served for script ${url}`);
    });
    let viewport = null;
    let renderer = null;
    if (mode !== "web") {
      viewport = new NativeViewportProcess({
        executable: viewportBinary,
        mapRoot: identity.mapRoot,
        args: ["--embedded"],
      });
      renderer = new NativeProcessRenderer(viewport);
      // Readiness and camera reports travel page-ward, exactly as they do
      // over Electron IPC.
      renderer.onReadiness((state, detail) => {
        void page.evaluate(([kind, payload]) => window.__nativeEvent?.(kind, payload),
          ["readiness", { state, detail }]).catch(() => {});
      });
      viewport.onEvent((event) => {
        if (event.event !== "camera-state") return;
        const state = renderer.cameraState();
        if (state) {
          void page.evaluate(([kind, payload]) => window.__nativeEvent?.(kind, payload),
            ["camera-state", state]).catch(() => {});
        }
      });
      await page.exposeFunction("__nativeCall", async (method, payload) => {
        if (method === "loadMap") {
          // The map root is a host path page script must never hold, so the
          // host resolves it and sends the command itself. `main.mjs` does
          // exactly this in its `native-viewport:load-map` handler; the
          // editor adapter deliberately cannot.
          await viewport.start();
          viewport.loadMap({
            mapRoot: identity.mapRoot,
            mapVersionId: payload.mapVersionId,
            releaseDigest: payload.releaseDigest,
          });
          return undefined;
        }
        if (method === "resize") return renderer.resize(payload);
        if (method === "setSelection") return renderer.setSelection(payload.ids);
        if (method === "applyCamera") return renderer.applyCamera(payload);
        if (method === "pick") return renderer.pick(payload);
        if (method === "dispose") return renderer.dispose();
        throw new Error(`unknown native bridge method ${method}`);
      });
    }
    const query = new URLSearchParams({
      mode,
      manifest: `http://localhost:${parityMapPort}/${sourceMapId}/3d/manifest.json`,
      mapVersionId: identity.mapVersionId,
      releaseDigest: identity.releaseDigest,
    });
    await page.goto(`http://localhost:${parityVitePort}/editor.html?${query}`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__editor), null, { timeout: 60_000 });
    return { page, viewport, renderer, pageErrors };
  }

  /** The interaction script. Identical for both backends, by construction. */
  async function exercise(session) {
    const { page } = session;
    // Wait for drawable OR failure: a backend that reported `error` has
    // answered, and burning the timeout hides the message it sent.
    await page.waitForFunction(
      () => window.__editor.drawable() || window.__editor.nativeReadiness() === "error",
      null,
      { timeout: 300_000 },
    );
    const failed = await page.evaluate(() => window.__editor.nativeReadiness());
    if (failed === "error") {
      throw new Error(`renderer reported error: ${await page.evaluate(() => window.__editor.readinessLog().join(","))}`);
    }
    // React panels must still be around the viewport; a native window that
    // ate the page is a compositing failure, not a renderer success.
    const panels = await page.locator("[data-panel]").count();
    const bounds = JSON.parse(await readFile(join(bundle, "3d/manifest.json"), "utf8")).scene.bounds;
    const centre = [0, 1, 2].map((axis) => (bounds.min[axis] + bounds.max[axis]) / 2);

    const footprint = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]);
    const position = [centre[0], centre[1] + footprint * 0.35, centre[2] + footprint * 0.5];
    await page.evaluate(([eye, target]) => window.__editor.setPose(eye, target), [position, centre]);
    // The renderer is the authority on its own camera, so parity is "the pose
    // the editor asked for came back", not "the editor remembers asking".
    const reported = await page.waitForFunction((expected) => {
      const state = window.__editor.cameraState();
      if (!state) return null;
      const close = state.pose.position.every((value, index) => Math.abs(value - expected[index]) < 1);
      return close ? state : null;
    }, position, { timeout: 60_000 }).then((handle) => handle.jsonValue());
    await page.evaluate(() => window.__editor.resizeRegion(900, 600));
    await sleep(500);
    return {
      renderer: await page.evaluate(() => window.__editor.renderer()),
      readiness: await page.evaluate(() => window.__editor.readiness()),
      panels,
      poseReported: reported.pose.position,
      fovYDeg: reported.intrinsics.fovYDeg,
      pageErrors: session.pageErrors.slice(0, 5),
    };
  }

  /**
   * Grab the whole X display, not the page.
   *
   * The native surface is an OS window positioned over the editor's viewport
   * region (option (a) in `renderer/viewport/PROTOCOL.md`), so it is not in
   * the page's compositor and `page.screenshot()` cannot see it. Only a
   * server-side grab shows the actual composite: React chrome from the
   * browser window, map pixels from the viewport process.
   */
  async function captureDisplay(file) {
    await new Promise((done, fail) => {
      const grab = spawn("ffmpeg", [
        "-loglevel", "error", "-y",
        "-f", "x11grab", "-video_size", "1280x800", "-i", `${process.env.DISPLAY}+0,0`,
        "-frames:v", "1", file,
      ], { stdio: "ignore" });
      grab.on("exit", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg x11grab exited ${code}`))));
      grab.on("error", fail);
    });
    return file;
  }
  const sessions = [];
  try {
    // --- web -------------------------------------------------------------
    const web = await session("web");
    sessions.push(web);
    const webResult = await exercise(web);
    record("parity.web-editor-interactions", webResult.renderer === "web" && webResult.panels >= 2
      && webResult.pageErrors.length === 0, webResult);

    // --- native ----------------------------------------------------------
    const native = await session("native");
    sessions.push(native);
    const nativeResult = await exercise(native);
    const nativeResized = native.viewport.running;
    // Visual evidence of the composite while the native session is live and
    // its window is positioned over the viewport region.
    const shot = shotDir ? await captureDisplay(join(shotDir, "native-composited-editor.png")) : null;
    record("parity.native-editor-interactions",
      nativeResult.renderer === "native" && nativeResult.panels >= 2 && nativeResized
      && nativeResult.pageErrors.length === 0,
      { ...nativeResult, viewportStillRunning: nativeResized, screenshot: shot });

    // Same script, same reported pose, from two different renderers.
    const poseMatches = webResult.poseReported
      .every((value, index) => Math.abs(value - nativeResult.poseReported[index]) < 1);
    record("parity.same-pose-from-both-backends", poseMatches, {
      web: webResult.poseReported,
      native: nativeResult.poseReported,
    });

    // --- explicit native must fail loudly, never fall back ---------------
    const broken = await session("native", { viewportBinary: join(root, "renderer/target/release/does-not-exist") });
    sessions.push(broken);
    await broken.page.waitForFunction(() => window.__editor.readiness() === "error", null, { timeout: 120_000 })
      .catch(() => {});
    const brokenState = {
      renderer: await broken.page.evaluate(() => window.__editor.renderer()),
      readiness: await broken.page.evaluate(() => window.__editor.readiness()),
      nativeFallback: await broken.page.evaluate(() => window.__editor.nativeFallback()),
      webCanvasPresent: await broken.page.evaluate(() => window.__editor.webCanvasPresent()),
      error: await broken.page.evaluate(() => window.__editor.error()),
    };
    record("parity.explicit-native-never-falls-back",
      brokenState.renderer === "native" && brokenState.readiness === "error"
      && brokenState.nativeFallback === "none" && brokenState.webCanvasPresent === false
      && Boolean(brokenState.error),
      brokenState);

    // The contrast that gives the assertion above its teeth: the identical
    // failure under `auto` DOES land on WebGL.
    const auto = await session("auto", { viewportBinary: join(root, "renderer/target/release/does-not-exist") });
    sessions.push(auto);
    await auto.page.waitForFunction(() => window.__editor.webCanvasPresent(), null, { timeout: 120_000 })
      .catch(() => {});
    const autoState = {
      renderer: await auto.page.evaluate(() => window.__editor.renderer()),
      webCanvasPresent: await auto.page.evaluate(() => window.__editor.webCanvasPresent()),
    };
    record("parity.auto-falls-back-to-webgl",
      autoState.webCanvasPresent && autoState.renderer === "web-after-native-fallback", autoState);
  } finally {
    for (const session of sessions) {
      await session.page.close().catch(() => {});
      session.viewport?.stop();
    }
    await browser.close().catch(() => {});
    await vite.close();
    await new Promise((done) => mapServer.close(done));
  }
}
// ---------------------------------------------------------------------------
// memory-census: attribute the driver's per-process GPU bytes to named
// categories, and state what is left unexplained.
//
// Three ledgers, never conflated:
//   * scheduler accounting  — what the residency planner believes it admitted
//   * wgpu/hal counters     — what wgpu's backend actually allocated
//   * nvidia-smi per-process— what the driver charges the process
//
// The driver figure is polled throughout the run and reduced to a MAX, so it
// is a peak rather than the single dwell-time sample `gpuProcessBytes` is.
// The fixed driver-side overhead (contexts, shader binaries, driver heaps)
// is measured on the empty scene before the map loads, not assumed.
// ---------------------------------------------------------------------------

/** Per-process GPU bytes from the driver. Total `memory.used` is useless: the GPU is shared. */
async function driverBytes(pid) {
  const out = await new Promise((done) => {
    const child = spawn("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "";
    child.stdout.on("data", (chunk) => { text += String(chunk); });
    child.on("exit", () => done(text));
    child.on("error", () => done(""));
  });
  for (const line of out.split("\n")) {
    const [reported, mib] = line.split(",").map((field) => field.trim());
    if (Number(reported) === pid) return Number(mib) * 1024 * 1024;
  }
  return null;
}

/** Peak host RSS the kernel recorded for the process, in bytes. */
async function hostPeakBytes(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  const match = /^VmHWM:\s+(\d+) kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

/** Poll the driver until stopped, keeping every sample. */
function pollDriver(pid, intervalMs) {
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const value = await driverBytes(pid);
      if (value !== null) samples.push({ at: Date.now(), value });
      await sleep(intervalMs);
    }
  })();
  return {
    samples,
    async stop() {
      stopped = true;
      await loop;
      return samples;
    },
  };
}

async function censusOneMap(sourceMapIdForCensus) {
  const identity = await hostIdentity(sourceMapIdForCensus);
  // Same flags the ten-map benchmark launches with, because the driver
  // figure being explained is the one that table reports.
  const run = await launch(identity.mapRoot, ["--memory-census", ...BENCH_VIEWPORT_ARGS]);
  try {
    await run.started;
    const pid = run.viewport.pid;
    const driver = pollDriver(pid, censusSampleMs);
    // The empty-scene settle: the viewport is up, the swapchain and every
    // render target exist, no map byte does. This is where the render-target
    // and driver-overhead baselines come from.
    await sleep(3000);
    const baselineDriverBytes = Math.max(0, ...driver.samples.map((sample) => sample.value));
    const censusAt = (label) => waitFor(run.events, (event) => event.event === "memory-census" && event.label === label, 120_000, `memory-census ${label}`);
    run.viewport.send({ command: "memory-census", label: "empty-scene" });
    const emptyScene = await censusAt("empty-scene");

    run.viewport.loadMap(identity);
    const manifest = await waitFor(run.events, (event) => event.event === "manifest-ready", 180_000, "manifest-ready");
    const interactive = await waitFor(run.events, (event) => event.event === "interactive", 180_000, "interactive");
    const complete = await waitFor(run.events, (event) => event.event === "complete", completeTimeoutMs, "complete");
    run.viewport.send({ command: "memory-census", label: "at-complete" });
    const atComplete = await censusAt("at-complete");
    // Then the benchmark's own camera path. Standing still at the load pose
    // never admits the far side of the map, never evicts, and never
    // exercises the allocator churn the driver figure is mostly made of: a
    // census taken there explains a number nobody reported.
    if (!manifest.sceneBounds) throw new Error("manifest-ready carried no sceneBounds");
    const poses = cameraPath(manifest.sceneBounds);
    for (const pose of poses) {
      run.viewport.setCamera(pose.position, pose.target);
      await sleep(BENCH_DWELL_MS);
    }
    run.viewport.send({ command: "memory-census", label: "after-camera-path" });
    const afterPath = await censusAt("after-camera-path");
    const driverPeakBytes = Math.max(0, ...driver.samples.map((sample) => sample.value));

    // Then the retirement half: evict everything, poll the device to
    // completion, and ask the driver again. Releasing an ECS handle is not
    // proof the GPU retired the memory.
    run.viewport.send({ command: "memory-census", label: "after-eviction", evictAll: true });
    const afterEviction = await censusAt("after-eviction");
    const afterEvictionDriverBytes = await driverBytes(pid);
    const hostPeak = await hostPeakBytes(pid);
    const samples = await driver.stop();

    // What the census claims to explain. `wgpuTotalBytes` is measured; the
    // driver-side remainder is measured too, on the empty scene, and held
    // fixed across the run. Anything left over is stated, not absorbed.
    const driverOverheadBytes = Math.max(0, baselineDriverBytes - emptyScene.current.wgpuTotalBytes);
    const explainedBytes = afterPath.peak.wgpuTotalBytes + driverOverheadBytes;
    const residualBytes = driverPeakBytes - explainedBytes;
    const residualFraction = driverPeakBytes > 0 ? residualBytes / driverPeakBytes : null;
    return {
      map: identity.mapVersionId,
      sourceMapId: sourceMapIdForCensus,
      mapRoot: identity.mapRoot,
      timeToInteractiveMs: interactive.elapsedMs,
      timeToCompleteMs: complete.elapsedMs,
      driver: {
        peakBytes: driverPeakBytes,
        emptySceneBytes: baselineDriverBytes,
        afterEvictionBytes: afterEvictionDriverBytes,
        overheadBytes: driverOverheadBytes,
        overheadSource: "nvidia-smi per-process on the empty scene minus wgpu's own allocation total there: contexts, shader binaries and driver heaps wgpu never sees",
        samples: samples.length,
        sampleIntervalMs: censusSampleMs,
        source: "nvidia-smi-per-process, max over samples (a peak, not a dwell sample)",
      },
      hostPeakResidentBytes: { value: hostPeak, source: "/proc/<pid>/status VmHWM" },
      wgpuCountersAvailable: afterPath.wgpuCountersAvailable === true,
      renderFramesSampled: afterPath.renderFramesSampled,
      cameraPath: poses.map((pose) => pose.name),
      scheduler: afterPath.scheduler,
      emptyScene: emptyScene.current,
      atComplete: { current: atComplete.current, scheduler: atComplete.scheduler },
      afterCameraPath: { current: afterPath.current, peak: afterPath.peak, baseline: afterPath.baseline },
      afterEviction: { current: afterEviction.current, unreclaimed: afterEviction.unreclaimed },
      reconciliation: {
        explainedBytes,
        residualBytes,
        residualFraction,
        // The number the whole exercise exists to kill.
        schedulerToDriverRatio: afterPath.scheduler.peakResidentBytes > 0
          ? driverPeakBytes / afterPath.scheduler.peakResidentBytes
          : null,
        note: "explainedBytes = wgpu peak buffer+texture allocation over the whole run (measured) + empty-scene driver overhead (measured). residualBytes is what neither ledger accounts for.",
      },
    };
  } finally {
    run.stop();
  }
}

async function checkMemoryCensus() {
  const census = { ranAt: new Date().toISOString(), binary, cacheRoot, maps: [] };
  for (const id of censusMapIds) {
    const entry = await censusOneMap(id);
    census.maps.push(entry);
    // Before anything is believed: wgpu's allocation counters compile to a
    // no-op that reads 0 unless the `counters` feature is on, and a ledger
    // of zeroes is indistinguishable from a tidy result.
    record(`memory-census.${id}.wgpu-counters-live`, entry.wgpuCountersAvailable, {
      wgpuBufferBytes: entry.atComplete.current.wgpuBufferBytes,
      wgpuTextureBytes: entry.atComplete.current.wgpuTextureBytes,
      wgpuAllocations: entry.atComplete.current.wgpuAllocations,
      renderFramesSampled: entry.renderFramesSampled,
    });
    const fraction = entry.reconciliation.residualFraction;
    record(`memory-census.${id}.driver-bytes-attributed`, fraction !== null && Math.abs(fraction) <= censusTolerance, {
      map: entry.map,
      driverPeakBytes: entry.driver.peakBytes,
      schedulerPeakBytes: entry.scheduler.peakResidentBytes,
      schedulerToDriverRatio: entry.reconciliation.schedulerToDriverRatio,
      wgpuPeakBytes: entry.afterCameraPath.peak.wgpuTotalBytes,
      driverOverheadBytes: entry.driver.overheadBytes,
      residualBytes: entry.reconciliation.residualBytes,
      residualFraction: fraction,
      tolerance: censusTolerance,
    });
    // A category ledger that does not name where its bytes came from is a
    // guess with extra steps, so the presence of every category is asserted.
    const categories = entry.afterCameraPath.peak.categories;
    const named = Object.entries(categories).filter(([, value]) => typeof value?.source === "string" && typeof value?.allocatedBy === "string");
    record(`memory-census.${id}.categories-name-their-code-path`, named.length === Object.keys(categories).length, {
      categories: Object.fromEntries(Object.entries(categories).map(([name, value]) => [name, value.bytes])),
      named: named.length,
    });
  }
  if (censusJsonPath) await writeFile(censusJsonPath, `${JSON.stringify(census, null, 2)}\n`);
  console.log(censusTable(census));
}

/** The before/after table the video has to show on screen. */
function censusTable(census) {
  const mib = (value) => (value === null || value === undefined ? "n/a" : `${(value / 1024 / 1024).toFixed(0)} MiB`);
  const lines = [
    "",
    "map                     scheduler      wgpu peak    driver peak   ratio   residual",
    "--------------------------------------------------------------------------------",
  ];
  for (const entry of census.maps) {
    lines.push(
      [
        entry.sourceMapId.padEnd(22),
        mib(entry.scheduler.peakResidentBytes).padStart(12),
        mib(entry.afterCameraPath.peak.wgpuTotalBytes).padStart(13),
        mib(entry.driver.peakBytes).padStart(14),
        `${(entry.reconciliation.schedulerToDriverRatio ?? 0).toFixed(2)}x`.padStart(8),
        `${((entry.reconciliation.residualFraction ?? 0) * 100).toFixed(1)}%`.padStart(10),
      ].join(""),
    );
  }
  return lines.join("\n");
}


const runners = {
  identity: checkIdentity,
  protocol: checkProtocol,
  pick: checkPick,
  readiness: checkReadiness,
  progressive: checkProgressive,
  parity: checkParity,
  "memory-census": checkMemoryCensus,
};
for (const check of selected) {
  try {
    await runners[check]();
  } catch (error) {
    record(check, false, { error: error instanceof Error ? error.message : String(error) });
  }
}

const report = {
  binary,
  cacheRoot,
  map: sourceMapId,
  progressiveMap: progressiveMapId,
  ranAt: new Date().toISOString(),
  checks: results,
  ok: results.every((entry) => entry.ok),
};
const jsonPath = args.get("json");
if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: report.ok, checks: results.length, failed: results.filter((entry) => !entry.ok).map((entry) => entry.check) }));
process.exit(report.ok ? 0 : 1);
