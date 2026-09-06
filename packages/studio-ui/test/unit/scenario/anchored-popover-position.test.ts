import { describe, expect, it } from "vitest";
import { computeAnchoredPopoverPlacement } from "../../../src/lib/scenario/editor/anchored-popover";

/**
 * jsdom reports zero for every `getBoundingClientRect`, so anchoring POSITIONS
 * can never be asserted from a rendered tree. The geometry is split out as a
 * pure function precisely so it can be driven from synthetic rects — this file
 * is the reason that split exists.
 */

const VIEWPORT = { height: 900, width: 1440 };

/** The clip card's calibration. */
const CLIP = {
  maxPreferredHeight: 420,
  minimumUsefulHeight: 220,
  panelHeight: 300,
  preferredWidth: 380,
};

/** The actor card's calibration, unchanged by the extraction. */
const ACTOR = {
  maxPreferredHeight: 440,
  minimumUsefulHeight: 300,
  panelHeight: 300,
  preferredWidth: 504,
};

function rect(top: number, left: number, width = 40, height = 28) {
  return { bottom: top + height, left, top, width, height };
}

describe("computeAnchoredPopoverPlacement — side", () => {
  it("opens above when there is room, and sits its bottom on the pointer gap", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 700),
      viewport: VIEWPORT,
    });

    expect(placement.side).toBe("above");
    // 700 (anchor top) − 18 (pointer gap) − 300 (occupied height).
    expect(placement.top).toBe(382);
  });

  it("flips below when the space above is neither useful nor the larger half", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(40, 700),
      viewport: VIEWPORT,
    });

    expect(placement.side).toBe("below");
    expect(placement.top).toBe(40 + 28 + 18);
  });

  it("still opens above when above is cramped but below is worse", () => {
    // 210 px above is under the 220 px usefulness bar, but below has 60.
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(244, 700),
      viewport: { height: 400, width: 1440 },
    });

    expect(placement.side).toBe("above");
  });
});

describe("computeAnchoredPopoverPlacement — horizontal clamp", () => {
  it("centres on the anchor when nothing is in the way", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 700),
      viewport: VIEWPORT,
    });

    expect(placement.left).toBe(720 - 380 / 2);
    expect(placement.pointerLeft).toBe(190);
  });

  it("pins to the left margin and walks the pointer back to its inset", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 0, 20),
      viewport: VIEWPORT,
    });

    expect(placement.left).toBe(16);
    // A clip at t=0 puts the pointer at the card's left inset, not off it.
    expect(placement.pointerLeft).toBe(28);
  });

  it("pins to the right margin and clamps the pointer to the far inset", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 1430, 10),
      viewport: VIEWPORT,
    });

    expect(placement.left).toBe(1440 - 380 - 16);
    expect(placement.pointerLeft).toBe(380 - 28);
  });

  it("narrows the card rather than overflowing a phone-width viewport", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 100),
      viewport: { height: 900, width: 320 },
    });

    expect(placement.width).toBe(320 - 32);
    expect(placement.left).toBe(16);
  });
});

describe("computeAnchoredPopoverPlacement — height", () => {
  it("caps at the preferred ceiling even with a whole screen to spare", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(800, 700),
      viewport: VIEWPORT,
    });

    expect(placement.maxHeight).toBe(420);
  });

  it("never drops below the usable floor, even in a short viewport", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(100, 700, 40, 20),
      viewport: { height: 300, width: 1440 },
    });

    // Available below is 146 px; the card overflows the margin instead of
    // rendering a 146 px form nobody can use.
    expect(placement.maxHeight).toBe(180);
  });

  it("lifts a content-sized card by its measured height, not a constant", () => {
    const short = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 700),
      panelHeight: 140,
      viewport: VIEWPORT,
    });
    const tall = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 700),
      panelHeight: 400,
      viewport: VIEWPORT,
    });

    // The pointer stays on the clip in both cases — the card grows upward.
    expect(short.top).toBe(700 - 18 - 140);
    expect(tall.top).toBe(700 - 18 - 400);
  });
});

/**
 * A clip's anchor is a segment INSIDE the bottom dock, so placing the card
 * against the anchor put it on top of the dock's own header, ruler and
 * neighbouring lanes — it covered the controls it is driven from, and on a
 * short viewport its footer ran off the bottom of the screen. Every card owes
 * the dock this clearance, not just the clip's.
 */
describe("computeAnchoredPopoverPlacement — clearing the bottom dock", () => {
  // A 40vh dock on a 900 px viewport: lanes from 540 down.
  const DOCK_TOP = 540;

  it("stops the card above the dock, not above its anchor", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 700),
      keepClearBelow: DOCK_TOP,
      viewport: VIEWPORT,
    });

    // 540 (dock top) − 18 (pointer gap) − 300 (occupied height), where the
    // unclamped placement put the card's bottom at 700 — 160 px into the dock.
    expect(placement.side).toBe("above");
    expect(placement.top).toBe(222);
    expect(placement.top + CLIP.panelHeight).toBeLessThanOrEqual(DOCK_TOP);
  });

  it("caps the height at the room actually above the dock", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 700),
      // A dock expanded far enough that 420 px no longer fits above it.
      keepClearBelow: 400,
      viewport: VIEWPORT,
    });

    // 400 − 16 (margin) − 18 (pointer gap).
    expect(placement.maxHeight).toBe(366);
  });

  it("leaves a card anchored above the dock exactly where it was", () => {
    // A map marker already sits above the dock, so the clamp is a no-op and
    // both cards keep obeying one rule rather than forking.
    const anchored = rect(300, 700);
    const withDock = computeAnchoredPopoverPlacement({
      ...ACTOR,
      anchor: anchored,
      keepClearBelow: DOCK_TOP,
      viewport: VIEWPORT,
    });
    const without = computeAnchoredPopoverPlacement({
      ...ACTOR,
      anchor: anchored,
      viewport: VIEWPORT,
    });

    expect(withDock).toEqual(without);
  });

  it("never starves the card below its absolute minimum", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(700, 700),
      // A dock so tall there is almost nothing above it.
      keepClearBelow: 60,
      viewport: VIEWPORT,
    });

    // Overflowing the margin beats rendering a 26 px card.
    expect(placement.maxHeight).toBe(180);
  });
});

describe("computeAnchoredPopoverPlacement — actor card parity", () => {
  /**
   * The extraction must not have moved the actor popover by a pixel. These are
   * the values the inline effect produced for the same inputs.
   */
  it("reproduces the actor popover's placement", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...ACTOR,
      anchor: rect(600, 600, 24, 24),
      viewport: VIEWPORT,
    });

    expect(placement).toEqual({
      left: 612 - 504 / 2,
      maxHeight: 440,
      pointerLeft: 252,
      pointerTop: 0,
      side: "above",
      top: 600 - 18 - 300,
      width: 504,
    });
  });
});

/**
 * The clip card opens beside the sidebar rather than over it.
 *
 * Its anchor is a segment inside the left panel, so the above/below rule kept
 * the card in the sidebar's own column, on top of the lanes it was opened from.
 * `placeWithin` puts it over the map instead.
 */
describe("computeAnchoredPopoverPlacement — right of the sidebar", () => {
  /** The map stage: right of the 500px sidebar, below the 109px toolbar. */
  const MAP = { left: 500, top: 109, bottom: 720 };

  it("opens in a column just right of the sidebar, clear of it", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(300, 200),
      viewport: VIEWPORT,
      placeWithin: MAP,
    });

    expect(placement.side).toBe("right");
    expect(placement.left).toBe(MAP.left + 18);
    // Entirely clear of the panel it is anchored into.
    expect(placement.left).toBeGreaterThanOrEqual(MAP.left);
  });

  it("lands in the same column wherever along the track the clip sits", () => {
    // The whole point of anchoring to the sidebar edge and not the clip: the
    // card must not slide left and right as different clips are clicked.
    const early = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(300, 200),
      viewport: VIEWPORT,
      placeWithin: MAP,
    });
    const late = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(300, 460),
      viewport: VIEWPORT,
      placeWithin: MAP,
    });

    expect(late.left).toBe(early.left);
  });

  it("centres on the clip and points its tail back at it", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(300, 200),
      viewport: VIEWPORT,
      placeWithin: MAP,
    });

    const anchorMiddle = 300 + 28 / 2;
    expect(placement.top).toBe(anchorMiddle - 300 / 2);
    // The tail sits on the left edge, level with the clip.
    expect(placement.top + placement.pointerTop).toBeCloseTo(anchorMiddle, 6);
  });

  it("never rides up over the toolbar for a clip at the top of the timeline", () => {
    // The reason the boundary is a REGION and not just the sidebar's right
    // edge: centred on this clip the card would start above the map, covering
    // the toolbar the map sits below.
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(20, 200),
      viewport: VIEWPORT,
      placeWithin: MAP,
    });

    expect(placement.top).toBe(MAP.top + 16);
    // Clamped away from the anchor's middle, so the tail re-aims rather than
    // floating off the card's top edge.
    expect(placement.pointerTop).toBeGreaterThanOrEqual(28);
  });

  it("pins an offscreen projected actor card inside the visible editor region", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...ACTOR,
      anchor: rect(-1084, 900, 1, 1),
      viewport: VIEWPORT,
      placeWithin: MAP,
    });

    expect(placement.top).toBe(MAP.top + 16);
    expect(placement.left).toBeGreaterThanOrEqual(MAP.left);
    expect(placement.top).toBeGreaterThanOrEqual(0);
  });

  it("keeps a clip near the bottom of the timeline inside the map", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(880, 200),
      viewport: VIEWPORT,
      placeWithin: MAP,
    });

    expect(placement.top + 300).toBeLessThanOrEqual(MAP.bottom - 16);
    expect(placement.pointerTop).toBeLessThanOrEqual(300 - 28);
  });

  it("overflows the bottom rather than the toolbar when the map is short", () => {
    // A card taller than the region inverts the clamp; the floor has to win, or
    // a short map would push the card up under the buttons.
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(300, 200),
      panelHeight: 400,
      viewport: VIEWPORT,
      placeWithin: { left: 500, top: 109, bottom: 400 },
    });

    expect(placement.top).toBeGreaterThanOrEqual(109);
  });

  it("does not run off a narrow viewport", () => {
    const placement = computeAnchoredPopoverPlacement({
      ...CLIP,
      anchor: rect(300, 200),
      viewport: { height: 900, width: 820 },
      placeWithin: { left: 700, top: 109, bottom: 720 },
    });

    expect(placement.left + placement.width).toBeLessThanOrEqual(820 - 16);
  });

  it("leaves every map-anchored card on the above/below rule", () => {
    // `placeWithin` is opt-in per card; the actor and intersection cards are
    // anchored to things already on the map and must not move.
    const placement = computeAnchoredPopoverPlacement({
      ...ACTOR,
      anchor: rect(600, 600, 24, 24),
      viewport: VIEWPORT,
    });

    expect(placement.side).toBe("above");
  });
});
