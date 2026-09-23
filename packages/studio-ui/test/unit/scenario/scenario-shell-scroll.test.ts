import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The scenario page's shell must never scroll; only the dataset strip's list and the scenario list
 * do. In rc.73 an expanded map group called `scrollIntoView`, which scrolled the `overflow: hidden`
 * pane box: the rail and the column header slid under the top bar and an empty band opened under the
 * map until a reload. jsdom lays nothing out, so the contract is pinned at the source; the e2e
 * (`e2e/flows/core-studio-shell-layout.spec.ts`) measures it in a browser.
 */
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const studio = (path: string) => readFileSync(new URL(`../../../../../studio/${path}`, import.meta.url), "utf8");

describe("scenario page shell", () => {
  it("defines scroll.clip as overflow: clip, which nothing can scroll", () => {
    const recipes = read("src/stylex/recipes.stylex.ts");
    expect(recipes).toMatch(/export const scroll = stylex\.create\(\{\n  clip: \{ overflow: "clip" \},/);
  });

  it.each([
    ["dashboard layout", studio("app/dashboard/layout.tsx"), ["styles.divFlex", "styles.main"]],
    ["top bar", studio("app/components/AppTopBar.tsx"), ["styles.header"]],
    ["workspace panes", read("src/components/WorkspacePanes.tsx"), ["styles.root", "styles.panes", "styles.stage", "styles.inspector"]],
    ["scenario page", read("src/scenario/ScenarioDatasetsClient.tsx"), ["styles.scenarioDatasetIndex", "styles.panelGrid"]],
    ["dataset strip", read("src/scenario/rail/DatasetStrip.tsx"), ["styles.strip"]],
    ["scenario column", read("src/scenario/dataset/ScenarioDatasetDetailClient.tsx"), ["styles.column", "styles.body"]],
  ])("%s clips its shell boxes", (_name, source, boxes) => {
    for (const style of boxes) {
      expect(source, style).toContain(`stylex.props(scroll.clip, ${style}`);
    }
  });

  it.each([
    ["dashboard layout", studio("app/dashboard/layout.stylex.ts")],
    ["workspace panes", read("src/components/WorkspacePanes.stylex.ts")],
    ["scenario page", read("src/scenario/ScenarioDatasetsClient.stylex.ts")],
  ])("%s declares no scrollable overflow of its own", (_name, source) => {
    expect(source).not.toMatch(/overflow(Y)?:\s*"(hidden|auto|scroll)"/);
  });

  it("makes the strip's list and the scenario list the scrollers", () => {
    expect(read("src/scenario/rail/DatasetStrip.tsx")).toContain("stylex.props(\n            scroll.y,\n            styles.list,");
    expect(read("src/scenario/list/ScenarioDocumentCreator.tsx")).toContain(
      "stylex.props(scroll.y, styles.scenarioDocumentList)",
    );
  });

  it.each([
    "src/scenario/list/ScenarioDocumentCreator.tsx",
    "src/scenario/rail/ScenarioScenarioRail.tsx",
    "src/scenario/rail/DatasetStrip.tsx",
    "src/scenario/dataset/ScenarioDatasetDetailClient.tsx",
    "src/scenario/ScenarioDatasetsClient.tsx",
  ])("%s follows a selection with revealInScroller, not scrollIntoView", (path) => {
    expect(read(path)).not.toMatch(/\.scrollIntoView\(/);
  });
});
