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
// Environment:
//   SIMFORGE_MAPS_CACHE_ROOT  cache root holding `.corpus/<sourceMapId>`
//                             (default: $XDG_DATA_HOME/simforge/maps)
//   SIMFORGE_NATIVE_VIEWPORT  viewport binary (default: renderer/target/release/...)

import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { register } from "tsx/esm/api";

register();
const { NativeViewportProcess } = await import("../studio/desktop/native-viewport.mjs");
const { NativeProcessRenderer } = await import("../packages/viewer/src/native-process-renderer.ts");

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
await access(binary);

const CHECKS = ["identity", "protocol", "pick", "readiness", "progressive"];
const selected = (args.get("checks") ?? CHECKS.join(",")).split(",").filter((name) => CHECKS.includes(name));
const sourceMapId = args.get("map") ?? "richmond-field-station";
// How long `complete` may take. Lowerable so a scheduler that never settles
// reports in minutes instead of holding the suite for twenty of them.
const completeTimeoutMs = Number(args.get("complete-timeout-ms") ?? 1_200_000);
// `--map` selects the map for every check, progressive included; the largest
// canonical map stays the default so the unflagged suite keeps stressing it.
// Without this, `--checks=progressive --map=X` silently measured a different
// map than the one named on the command line.
const progressiveMapId = args.get("progressive-map") ?? args.get("map") ?? "san-ramon-phase-2";
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
  const run = await launch(identity.mapRoot);
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

const runners = {
  identity: checkIdentity,
  protocol: checkProtocol,
  pick: checkPick,
  readiness: checkReadiness,
  progressive: checkProgressive,
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
