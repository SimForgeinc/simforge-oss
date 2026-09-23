// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { nearestScroller, revealInScroller } from "../../../src/lib/reveal-in-scroller";

/**
 * `revealInScroller` exists because `scrollIntoView` scrolled the scenario page's clipped pane shell
 * (rc.73): the rail and column header slid under the top bar and an empty band opened under the map.
 * jsdom lays nothing out, so boxes are stubbed: what is pinned is which element's `scrollTop` moves.
 */
function box(element: Element, top: number, height: number) {
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

function tree() {
  document.body.innerHTML = `
    <div id="shell" style="overflow: hidden">
      <ul id="list" style="overflow-y: auto">
        <li id="first"></li><li id="target"></li>
      </ul>
    </div>`;
  const shell = document.getElementById("shell")!;
  const list = document.getElementById("list")!;
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 });
  box(shell, 0, 400);
  box(list, 100, 300);
  return { shell, list, target: document.getElementById("target")! };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("revealInScroller", () => {
  it("finds the nearest ancestor that scrolls on purpose, skipping clipped shells", () => {
    const { list, target, shell } = tree();
    expect(nearestScroller(target)).toBe(list);
    expect(nearestScroller(list)).toBeNull();
    expect(shell.scrollTop).toBe(0);
  });

  it("scrolls only the list, by the least distance, when the item is below the fold", () => {
    const { shell, list, target } = tree();
    box(target, 420, 40); // 60px past the list's bottom edge at 400
    revealInScroller(target);
    expect(list.scrollTop).toBe(60);
    expect(shell.scrollTop).toBe(0);
  });

  it("scrolls up when the item is above the list's top edge", () => {
    const { list, target } = tree();
    list.scrollTop = 200;
    box(target, 60, 40); // 40px above the list's top edge at 100
    revealInScroller(target);
    expect(list.scrollTop).toBe(160);
  });

  it("shows the start of an item taller than the list instead of its end", () => {
    const { list, target } = tree();
    box(target, 250, 900);
    revealInScroller(target);
    expect(list.scrollTop).toBe(150);
  });

  it("leaves a fully visible item alone", () => {
    const { list, target } = tree();
    box(target, 150, 40);
    revealInScroller(target);
    expect(list.scrollTop).toBe(0);
  });
});
