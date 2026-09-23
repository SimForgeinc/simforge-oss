import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * jsdom lays nothing out, so the layout contract of the dataset strip + scenario column grid is
 * pinned at the source.
 *
 * The grid's one row must be bounded to the grid's height. Left as an implicit `auto` track it grows
 * to the strip's full icon column once a workspace has more datasets than fit the window, and the
 * overflow-hidden page clips the bottom of both panes: the strip and the scenario list stop
 * scrolling, and the "Add scenario" row at the foot of the column is drawn off-screen (rc.70–rc.73).
 */
describe("dataset panel grid", () => {
  const source = readFileSync(
    new URL("../../../src/scenario/ScenarioDatasetsClient.stylex.ts", import.meta.url),
    "utf8",
  );

  it("bounds its row to the grid height instead of the tallest pane's content", () => {
    const panelGrid = /\n  panelGrid: \{\n([\s\S]*?)\n  \},/.exec(source)?.[1];
    expect(panelGrid, "panelGrid style").toBeTruthy();
    expect(panelGrid).toMatch(/gridTemplateRows:\s*"minmax\(0, 1fr\)"/);
    expect(panelGrid).toMatch(/minHeight:\s*0/);
  });
});
