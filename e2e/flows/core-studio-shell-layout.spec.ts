/**
 * The scenario page's shell: dataset strip, scenario column and coverage map fill exactly the
 * viewport below the top bar, each scrolls within its own box, and nothing an interaction does can
 * scroll the shell around them.
 *
 * The regression this pins (rc.73): expanding a map group, or clicking a coverage region, called
 * `scrollIntoView`, which also scrolled the `overflow: hidden` pane box. The strip's first tiles and
 * the column header slid under the top bar and an empty band opened under the map, until a reload.
 * The shell boxes are now `overflow: clip`, which nothing can scroll, and lists follow a selection
 * with `revealInScroller`, which moves only the list.
 *
 * Needs no map corpus: the host seeds nothing, and the scenarios are mapless documents, which the
 * column groups under "No map".
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, launchBrowserStudio, test, type StudioSession } from "../support";
import { REPO_ROOT } from "../support/paths";

const DATASETS = 26;
const SCENARIOS = 40;
const SELECTED = "aaa";
/** The user's window, then the common laptop and small-laptop windows. */
const DESKTOP_SIZES = [
  { width: 2000, height: 1116 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
] as const;
const PHONE = { width: 390, height: 844 } as const;

type Box = { top: number; bottom: number; left: number; right: number };
type ShellGeometry = {
  viewportHeight: number;
  documentScrollTop: number;
  header: Box;
  index: Box;
  railList: Box & { scrollTop: number; scrollHeight: number; clientHeight: number };
  firstTile: Box;
  lastTile: Box;
  columnHeader: Box | null;
  newScenario: Box | null;
  map: Box | null;
  /** Boxes that are scrolled although they do not scroll on purpose: the shell moving. */
  scrolledShell: string[];
};

function geometry(page: Page): Promise<ShellGeometry> {
  return page.evaluate(() => {
    const box = (element: Element | null | undefined) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    };
    const must = (selector: string, root: ParentNode = document) => {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`missing ${selector}`);
      return element;
    };
    const railList = must('[data-testid="scenario-dataset-rail-list"]');
    const tiles = railList.querySelectorAll('[data-testid="scenario-dataset-icon"]');
    const scrolledShell: string[] = [];
    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (element.scrollTop === 0 && element.scrollLeft === 0) continue;
      const style = getComputedStyle(element);
      const deliberate = ["auto", "scroll"];
      if (deliberate.includes(style.overflowY) || deliberate.includes(style.overflowX)) continue;
      const id = element.getAttribute("data-testid") ?? element.className.toString().slice(0, 80);
      scrolledShell.push(`${element.tagName.toLowerCase()}[${id}] scrollTop=${element.scrollTop} scrollLeft=${element.scrollLeft}`);
    }
    return {
      viewportHeight: window.innerHeight,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      header: box(must('[data-testid="app-topbar"]'))!,
      index: box(must('[data-testid="scenario-dataset-index"]'))!,
      railList: {
        ...box(railList)!,
        scrollTop: railList.scrollTop,
        scrollHeight: railList.scrollHeight,
        clientHeight: railList.clientHeight,
      },
      firstTile: box(tiles[0])!,
      lastTile: box(tiles[tiles.length - 1])!,
      columnHeader: box(document.querySelector('[data-testid="scenario-scenario-list-header"]')),
      newScenario: box(document.querySelector('[data-testid="scenario-new-scenario"]')),
      map: box(document.querySelector('[data-testid="scenario-coverage-map"]')),
      scrolledShell,
    };
  });
}

/**
 * The layout contract. `railAtTop` asks for the first tile to be fully visible, which holds only
 * while the strip's own list is scrolled to its start.
 */
async function expectShellIntact(page: Page, label: string, options: { railAtTop?: boolean; map?: boolean } = {}) {
  const g = await geometry(page);
  const at = (what: string) => `${label}: ${what}`;
  expect(g.scrolledShell, at("no shell box is scrolled")).toEqual([]);
  expect(g.documentScrollTop, at("the document is not scrolled")).toBe(0);
  expect(g.header.top, at("the top bar starts at the top of the viewport")).toBe(0);
  expect(Math.abs(g.index.top - g.header.bottom), at("the page starts at the top bar's bottom")).toBeLessThanOrEqual(1);
  expect(Math.abs(g.index.bottom - g.viewportHeight), at("the page ends at the viewport's bottom")).toBeLessThanOrEqual(1);
  expect(g.railList.top, at("the strip's list starts below the top bar")).toBeGreaterThanOrEqual(g.header.bottom);
  expect(g.railList.bottom, at("the strip's list ends inside the viewport")).toBeLessThanOrEqual(g.viewportHeight + 1);
  expect(g.railList.scrollHeight, at("the strip's list scrolls, not the page")).toBeGreaterThan(g.railList.clientHeight);
  if (options.railAtTop ?? true) {
    expect(g.railList.scrollTop, at("the strip's list is at its start")).toBe(0);
    expect(g.firstTile.top, at("the first tile's top is below the top bar")).toBeGreaterThanOrEqual(g.header.bottom);
    expect(g.firstTile.top, at("the first tile is inside the strip's list")).toBeGreaterThanOrEqual(g.railList.top);
    expect(g.firstTile.bottom, at("the first tile is fully visible")).toBeLessThanOrEqual(g.railList.bottom);
  }
  expect(g.columnHeader, at("the column header is rendered")).not.toBeNull();
  expect(g.columnHeader!.top, at("the column header's top is below the top bar")).toBeGreaterThanOrEqual(g.header.bottom);
  expect(g.newScenario, at("the New scenario button is rendered")).not.toBeNull();
  expect(g.newScenario!.top, at("New scenario is below the top bar")).toBeGreaterThanOrEqual(g.header.bottom);
  expect(g.newScenario!.bottom, at("New scenario is inside the viewport")).toBeLessThanOrEqual(g.viewportHeight);
  await expect(page.getByTestId("scenario-new-scenario"), at("New scenario is in the viewport")).toBeInViewport();
  if (options.map ?? true) {
    // The studio has no bottom bar: the map runs to the viewport's bottom edge.
    expect(g.map, at("the coverage map is rendered")).not.toBeNull();
    expect(Math.abs(g.map!.top - g.header.bottom), at("the map starts at the top bar's bottom")).toBeLessThanOrEqual(1);
    expect(Math.abs(g.map!.bottom - g.viewportHeight), at("the map ends at the viewport's bottom")).toBeLessThanOrEqual(1);
  }
  return g;
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

async function seed(studio: StudioSession): Promise<void> {
  await studio.api("/api/simforge/host/setup", { method: "PUT", body: JSON.stringify({ mode: "local", quality: "low" }) });
  // The selected dataset is created last, so it is the strip's first tile, as in the report.
  for (let index = DATASETS - 1; index > 0; index -= 1) {
    await studio.api("/api/simforge/datasets", { method: "POST", body: JSON.stringify({ name: `Dataset ${String(index).padStart(2, "0")}` }) });
  }
  const selected = await studio.api<{ id: string }>("/api/simforge/datasets", { method: "POST", body: JSON.stringify({ name: SELECTED }) });
  const content: unknown = JSON.parse(await readFile(join(REPO_ROOT, "examples", "ltap-opposing.template.json"), "utf8"));
  for (let index = 1; index <= SCENARIOS; index += 1) {
    await studio.api("/api/simforge/documents", {
      method: "POST",
      body: JSON.stringify({
        title: `Scenario ${String(index).padStart(2, "0")}`,
        schemaVersion: "2",
        content,
        mapVersionId: null,
        datasetId: selected.id,
        authoringQualityId: "low",
      }),
    });
  }
}

async function openSelectedDataset(page: Page): Promise<void> {
  await expect(page.getByTestId("scenario-dataset-index")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("scenario-dataset-rail").getByRole("button", { name: SELECTED, exact: true }).click();
  await expect(page.getByTestId("scenario-document-index")).toHaveAttribute("data-dataset-id", /.+/);
  await expect(page.getByTestId("scenario-new-scenario")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("scenario-coverage-map")).toBeVisible({ timeout: 60_000 });
}

const noMapGroup = (page: Page) =>
  page.locator("[data-scenario-map-group]").filter({ hasText: "No map" }).locator("button[aria-expanded]").first();

test.describe("scenario page shell layout", () => {
  test("fills the viewport under the top bar and never scrolls the shell", async ({ e2e }, testInfo) => {
    const studio = await launchBrowserStudio(e2e, { route: "/dashboard/settings", viewport: DESKTOP_SIZES[0] });
    const { page } = studio;
    await seed(studio);
    await studio.goto("/dashboard/scenario");
    await openSelectedDataset(page);
    await page.getByTestId("scenario-dataset-rail-list").evaluate((list) => { list.scrollTop = 0; });

    for (const size of DESKTOP_SIZES) {
      await page.setViewportSize(size);
      await expectShellIntact(page, `${size.width}x${size.height} static`);
      await shot(page, testInfo, `shell-${size.width}x${size.height}`);
    }

    await page.setViewportSize(DESKTOP_SIZES[0]);
    const rest = await expectShellIntact(page, "at rest");

    // The rc.73 trigger: expanding a map group scrolls it into view. Only the list may move.
    await noMapGroup(page).click();
    await expect(page.getByText("Scenario 40")).toBeAttached();
    await expectShellIntact(page, "map group expanded");
    await page.getByTestId("scenario-document-list").evaluate((list) => { list.scrollTop = list.scrollHeight; });
    await noMapGroup(page).click();
    await noMapGroup(page).click();
    await expectShellIntact(page, "map group re-expanded from the list's end");

    // The strip scrolls on its own under the wheel, to its last tile, and nothing else moves.
    const railList = page.getByTestId("scenario-dataset-rail-list");
    await railList.hover();
    for (let step = 0; step < 20; step += 1) await page.mouse.wheel(0, 400);
    await expect.poll(() => railList.evaluate((list) => list.scrollTop + list.clientHeight >= list.scrollHeight - 1)).toBe(true);
    const wheeled = await expectShellIntact(page, "strip wheeled to its end", { railAtTop: false });
    expect(wheeled.lastTile.bottom, "the last tile is visible after the wheel").toBeLessThanOrEqual(wheeled.railList.bottom);
    expect(wheeled.lastTile.top).toBeGreaterThanOrEqual(wheeled.railList.top);
    expect(wheeled.header, "the top bar did not move").toEqual(rest.header);
    expect(wheeled.columnHeader?.top, "the column header did not move").toBe(rest.columnHeader?.top);
    expect(wheeled.map, "the map did not move").toEqual(rest.map);
    await expect(railList).toHaveAttribute("data-more-above", "true");
    await shot(page, testInfo, "shell-strip-wheeled");

    // Keyboard: Home/End/arrows move between tiles; the strip's list follows the focus.
    const tiles = page.getByTestId("scenario-dataset-rail").getByTestId("scenario-dataset-icon");
    await tiles.last().focus();
    await page.keyboard.press("Home");
    await expect(tiles.first()).toBeFocused();
    await expectShellIntact(page, "Home in the strip");
    await page.keyboard.press("ArrowDown");
    await expect(tiles.nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(tiles.last()).toBeFocused();
    const ended = await expectShellIntact(page, "End in the strip", { railAtTop: false });
    expect(ended.lastTile.bottom).toBeLessThanOrEqual(ended.railList.bottom);
    await page.keyboard.press("Home");
    await expectShellIntact(page, "back Home in the strip");

    // A plain focus() (Tab, a restored focus) scrolls the nearest scroller, never the shell.
    await tiles.last().evaluate((tile) => (tile as HTMLElement).focus());
    await expectShellIntact(page, "plain focus on the last tile", { railAtTop: false });
    await page.keyboard.press("Home");

    // The column's own controls: search takes focus, the New scenario picker opens and closes.
    await page.getByRole("button", { name: "Search scenarios" }).click();
    await expect(page.getByRole("searchbox", { name: "Filter scenarios by name" })).toBeFocused();
    await expectShellIntact(page, "search open");
    await page.getByRole("button", { name: "Hide scenario search" }).click();
    await page.getByTestId("scenario-new-scenario").click();
    await expect(page.getByRole("dialog", { name: "Select map" })).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Select map" })).toBeHidden();
    await expectShellIntact(page, "map picker closed");

    // Hardening: even with the shell overflowing again (the rc.73 grid, whose row grew to the strip's
    // full height), nothing scrolls it. `overflow: clip` boxes ignore focus, scrollIntoView and
    // scrollTop alike.
    const panelGrid = page.getByTestId("scenario-dataset-rail").locator("xpath=..");
    await panelGrid.evaluate((grid) => { (grid as HTMLElement).style.gridTemplateRows = "auto"; });
    await tiles.last().evaluate((tile) => { (tile as HTMLElement).focus(); tile.scrollIntoView({ block: "end" }); });
    await noMapGroup(page).click();
    await noMapGroup(page).click();
    const forced = await page.getByTestId("scenario-dataset-rail").evaluate((rail) => {
      const moved: string[] = [];
      for (let element = rail.parentElement; element; element = element.parentElement) {
        if (element === document.documentElement || element === document.body) continue;
        element.scrollTop = 500;
        if (element.scrollTop !== 0) moved.push(`${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)}`);
      }
      return moved;
    });
    expect(forced, "no shell box between the strip and the viewport can be scrolled").toEqual([]);
    await panelGrid.evaluate((grid) => { (grid as HTMLElement).style.gridTemplateRows = ""; });
    await page.getByTestId("scenario-dataset-rail-list").evaluate((list) => { list.scrollTop = 0; });
    await expectShellIntact(page, "after the forced-overflow drill");

    // Resizing keeps the contract.
    await page.setViewportSize(DESKTOP_SIZES[2]);
    await expectShellIntact(page, "resized down");
    await page.setViewportSize(DESKTOP_SIZES[0]);
    await expectShellIntact(page, "resized back");

    // Phone width: one pane at a time behind the pane switcher, all below the top bar.
    await page.setViewportSize(PHONE);
    await expectShellIntact(page, "phone list pane", { map: false });
    await shot(page, testInfo, `shell-${PHONE.width}x${PHONE.height}-list`);
    await page.getByRole("navigation", { name: "Workspace panes" }).getByRole("button", { name: "Detail" }).click();
    const detail = await geometry(page);
    expect(detail.scrolledShell).toEqual([]);
    expect(detail.map, "the detail pane shows the map").not.toBeNull();
    expect(detail.map!.top).toBeGreaterThanOrEqual(detail.header.bottom);
    expect(Math.abs(detail.map!.bottom - detail.viewportHeight), "the map ends at the viewport's bottom").toBeLessThanOrEqual(1);
    await shot(page, testInfo, `shell-${PHONE.width}x${PHONE.height}-detail`);
  });
});
