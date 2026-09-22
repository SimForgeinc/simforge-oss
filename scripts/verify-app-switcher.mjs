/**
 * Proves the minimal app switcher against a running Studio host: the overlay
 * offers exactly the three product tabs with their capability lines, the
 * utilities keep every other surface reachable, and the bar under the tabs is
 * one frame with no graphics-level control (Render Settings owns that).
 *
 *   node scripts/verify-app-switcher.mjs [--data-root ~/.simforge/cloud] [--out /tmp/ss-switcher]
 *
 * Headed Chrome with a real GPU, like the other browser verifications here.
 */
import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const dataRoot = option("data-root", join(homedir(), ".simforge", "cloud"));
const out = option("out", "/tmp/ss-switcher");

const host = JSON.parse(await readFile(join(dataRoot, "host.json"), "utf8"));
const auth = { authorization: `Bearer ${host.controlToken}` };
await mkdir(out, { recursive: true });

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

// A development host compiles the route on first request, which outlasts a
// browser navigation timeout. Warm it server-side first, with the control
// token the gate accepts, then hand the browser a session ticket.
const landing = "/dashboard/map-assets";
const warm = await fetch(`${host.baseUrl}${landing}`, {
  headers: auth,
  signal: AbortSignal.timeout(900_000),
});
check(warm.ok, `host served ${landing} (${warm.status})`);

const session = await fetch(`${host.baseUrl}/api/simforge/host/session`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ next: landing }),
});
if (!session.ok) throw new Error(`host session refused: ${session.status}`);
const { url } = await session.json();

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300_000 });
await page.getByRole("button", { name: /open app switcher/i }).click({ timeout: 120_000 });
const dialog = page.getByTestId("app-switcher-dialog");
await dialog.waitFor({ state: "visible", timeout: 30_000 });

const tabs = page.getByTestId("app-switcher-tabs").locator("[data-app]");
const labels = await tabs.evaluateAll((nodes) =>
  nodes.map((node) => node.getAttribute("data-app")),
);
check(
  JSON.stringify(labels) === JSON.stringify(["Maps", "Datasets", "Evaluation"]),
  `three tabs in order, got ${JSON.stringify(labels)}`,
);

const tabText = await tabs.evaluateAll((nodes) =>
  nodes.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? ""),
);
check(/GeoJSON layers/.test(tabText[0]) && /Map semantics/.test(tabText[0]) && /Drive on the map/.test(tabText[0]), "Maps tab names GeoJSON, semantics and driving");
check(/Training-ready/.test(tabText[1]) && /Simulation-ready/.test(tabText[1]) && /camera, LiDAR and radar/i.test(tabText[1]), "Datasets tab names training/simulation-ready and the sensors");
check(/AlpaMayo/.test(tabText[2]) && /Closed-loop model-in-the-loop/i.test(tabText[2]) && /Open-loop metrics/i.test(tabText[2]), "Evaluation tab names AlpaMayo, closed-loop and open-loop metrics");

const noArt = await dialog.locator("img[data-app-switcher-art]").count();
check(noArt === 0, "no per-app artwork remains");

const utilities = await dialog
  .getByRole("navigation", { name: "App utilities" })
  .locator("a")
  .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
for (const href of [
  "/dashboard/assets",
  "/dashboard/models",
  "/dashboard/dataset-export",
  "/dashboard/cloud-storage",
  "/dashboard/render-settings",
  "/dashboard/account",
  "/dashboard/settings",
]) {
  check(utilities.includes(href), `utility link reaches ${href}`);
}

const levelControls = await page.getByTestId("app-switcher-graphics-level").count();
check(levelControls === 0, `the bar has no graphics-level control, got ${levelControls}`);
const footers = await dialog.getByTestId("app-switcher-footer").count();
check(footers === 1, `utilities and account share one bar, got ${footers}`);
check(
  consoleErrors.length === 0,
  `no page errors on the switcher, got ${consoleErrors.slice(0, 3).join(" | ")}`,
);

await page.screenshot({ path: join(out, "app-switcher.png") });
// The destination route compiles on first request in development too.
await fetch(`${host.baseUrl}/dashboard/scenario`, {
  headers: auth,
  signal: AbortSignal.timeout(900_000),
});
await dialog.getByRole("link", { name: /^Datasets/ }).click();
await page.waitForURL(/\/dashboard\/scenario/, { timeout: 300_000 });
check(true, "Datasets tab navigates to /dashboard/scenario");
await page.screenshot({ path: join(out, "after-navigate.png") });

await browser.close();

console.log(`screenshots in ${out}`);
if (failures.length > 0) {
  console.error(`${failures.length} failed check(s)`);
  process.exit(1);
}
console.log("app switcher verified");
