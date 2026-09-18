#!/usr/bin/env node
// Walk the map gallery in a real browser at the highest graphics level and
// prove every installed map finishes loading.
//
// Readiness is the world host's own signal — `scenario-world-host` publishes
// `data-world-loaded-map-version-id` when the scene for that version is in the
// viewer — and liveness is the host's new `data-simforge-loading*` state, so a
// long load is distinguishable from a dead one without guessing.
//
//   node map-verify-maps.mjs [--timeout <seconds>] [--out <dir>]
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.STUDIO_BASE ?? "http://127.0.0.1:5199";
const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(homedir(), "map-verify");
const perMapTimeoutMs = Number(args.includes("--timeout") ? args[args.indexOf("--timeout") + 1] : 900) * 1000;
const host = JSON.parse(readFileSync(join(homedir(), ".simforge", "cloud", "host.json"), "utf8"));

const response = await fetch(`${BASE}/api/simforge/host/session`, {
  method: "POST",
  headers: { authorization: `Bearer ${host.controlToken}`, "content-type": "application/json" },
  body: JSON.stringify({ next: "/dashboard/map-assets" }),
});
if (!response.ok) throw new Error(`session ticket failed: ${response.status}`);
const { url: ticket } = await response.json();

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
// Highest fidelity before any app script runs, so the first mount uses it.
await context.addInitScript(() => {
  window.localStorage.setItem("simforge.rendering-preference.v1", "high");
});
const page = await context.newPage();
const events = [];
page.on("console", (message) => {
  const text = message.text();
  if (message.type() === "error" || /stalled|WebGL|out of memory/i.test(text)) {
    events.push({ at: Date.now(), text: `${message.type()}: ${text.slice(0, 200)}` });
  }
});
page.on("pageerror", (error) => events.push({ at: Date.now(), text: `pageerror: ${error.message.slice(0, 200)}` }));
page.on("requestfailed", (request) => {
  if (!/\/_next\/|hot-update|cloud\/status|host\/setup/.test(request.url())) {
    events.push({ at: Date.now(), text: `requestfailed: ${request.url().slice(-80)}` });
  }
});

await page.goto(ticket, { waitUntil: "domcontentloaded", timeout: 300_000 });
await page.goto(`${BASE}/dashboard/map-assets`, { waitUntil: "domcontentloaded", timeout: 300_000 });

const catalog = await page.evaluate(async () => {
  const maps = await (await fetch("/api/simforge/maps")).json();
  return maps.maps.map((m) => ({ id: m.mapVersionId, slug: m.sourceMapId, label: m.label }));
});
console.log(`gallery walk: ${catalog.length} maps at graphics level "high"\n`);

const results = [];
for (let index = 0; index < catalog.length; index += 1) {
  const started = Date.now();
  const before = events.length;
  const target = await page.evaluate(() =>
    document.querySelector('[data-testid="scenario-world-host"]')?.getAttribute("data-world-map-version-id") ?? null);
  const map = catalog.find((entry) => entry.id === target) ?? catalog[index];

  let status = "loaded";
  let detail = "";
  const samples = [];
  try {
    await page.waitForFunction(
      (expected) => {
        const host = document.querySelector('[data-testid="scenario-world-host"]');
        return host?.getAttribute("data-world-loaded-map-version-id") === expected;
      },
      map.id,
      { timeout: perMapTimeoutMs, polling: 2000 },
    );
  } catch (error) {
    status = "failed";
    detail = String(error).split("\n")[0].slice(0, 160);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const probe = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="scenario-world-host"]');
    const canvas = host?.querySelector("canvas");
    const gl = canvas?.getContext?.("webgl2");
    const root = document.documentElement;
    return {
      transition: host?.getAttribute("data-world-transition") ?? null,
      interactive: host?.getAttribute("data-world-interactive") ?? null,
      loading: root.getAttribute("data-simforge-loading"),
      loadingPhase: root.getAttribute("data-simforge-loading-phase"),
      loadingStalled: root.getAttribute("data-simforge-loading-stalled"),
      preference: window.localStorage.getItem("simforge.rendering-preference.v1"),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      renderer: gl ? String(gl.getParameter(gl.RENDERER)).slice(0, 40) : null,
      overlay: (document.querySelector('[data-testid="cloud-loading-content"]')?.textContent ?? "")
        .replace(/\s+/g, " ").trim().slice(0, 260),
    };
  });
  // A WebGL canvas without `preserveDrawingBuffer` reads back blank, so the
  // frame is measured from the composited screenshot the GPU actually painted.
  const shot = await page.screenshot({ path: join(OUT, `map-${map.slug}.png`) });
  const stats = await sharp(shot).resize(160, 100, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const seen = new Set();
  for (let offset = 0; offset < stats.data.length; offset += stats.info.channels) {
    seen.add(`${stats.data[offset] >> 4},${stats.data[offset + 1] >> 4},${stats.data[offset + 2] >> 4}`);
  }
  const distinctColors = seen.size;

  const mapEvents = events.slice(before).map((event) => event.text);
  results.push({ map: map.slug, label: map.label, status, seconds, detail, distinctColors, ...probe, events: mapEvents.slice(0, 6) });
  console.log(
    `${status === "loaded" ? "ok  " : "FAIL"} ${map.slug.padEnd(30)} ${seconds.padStart(7)}s `
    + `phase=${probe.transition} colors=${distinctColors} pref=${probe.preference} `
    + `stalled=${probe.loadingStalled ?? "-"} renderer=${probe.renderer}${detail ? ` :: ${detail}` : ""}`,
  );
  if (probe.overlay) console.log(`       overlay: ${probe.overlay}`);
  for (const event of mapEvents.slice(0, 4)) console.log(`       ${event}`);

  if (index + 1 < catalog.length) {
    const next = catalog[(index + 1) % catalog.length];
    const arrow = page.getByRole("button", { name: `Next map: ${next.label}` });
    if (await arrow.count() === 0) {
      console.log(`       no "Next map: ${next.label}" arrow; stopping the walk`);
      break;
    }
    // The overlay covers the arrows while a scene loads or reports; the walk
    // is still allowed to advance.
    await arrow.click({ force: true, timeout: 30_000 }).catch((error) => {
      console.log(`       could not advance: ${String(error).split("\n")[0].slice(0, 120)}`);
    });
    await page.waitForTimeout(1500);
  }
}

await writeFile(join(OUT, "verify-maps.json"), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((entry) => entry.status !== "loaded");
console.log(`\n${results.length - failed.length}/${results.length} maps loaded at high fidelity`);
if (failed.length) console.log(`failed: ${failed.map((entry) => entry.map).join(", ")}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
