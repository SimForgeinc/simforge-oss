/**
 * Asking a real browser two questions the DOM alone cannot answer: does this
 * surface receive input, and did this canvas actually paint?
 *
 * Both exist because of defects that were invisible to every other kind of
 * check. An interactive map was mounted inside a `pointer-events: none`
 * wrapper — present in the DOM, correctly sized, visibly rendered, and
 * completely dead to input; `toBeVisible()` passes on it, and so does a
 * click, because Playwright dispatches at the coordinate and the event goes
 * to whatever is really there. And a "frozen scene" was reported today from
 * fingerprinting the wrong canvas: the page holds two, and the decorative one
 * never changes.
 */

import type { Page } from "@playwright/test";

/**
 * Force `preserveDrawingBuffer` on every WebGL context the page creates.
 *
 * Without it `toDataURL`/`readPixels` after a frame returns blank or stale
 * content, because the browser is free to discard the drawing buffer once it
 * has composited. Must be installed with `addInitScript` before any
 * navigation: the world canvas takes its context during mount.
 */
export async function forcePreserveDrawingBuffer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    function patched(this: HTMLCanvasElement, type: string, attributes?: unknown): RenderingContext | null {
      const needsReadback = type === "webgl" || type === "webgl2" || type === "experimental-webgl";
      const merged = needsReadback
        ? { ...(typeof attributes === "object" && attributes !== null ? attributes : {}), preserveDrawingBuffer: true }
        : attributes;
      // `getContext` is overloaded per context type and its overloads cannot
      // be expressed by one wrapper signature; the runtime behaviour is a
      // pass-through, so the call is made through the erased form.
      const call = original as unknown as (
        this: HTMLCanvasElement, id: string, options?: unknown,
      ) => RenderingContext | null;
      return call.call(this, type, merged);
    }
    HTMLCanvasElement.prototype.getContext = patched as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });
}

export type HitTest = {
  /** The point tested, in viewport coordinates. */
  readonly x: number;
  readonly y: number;
  /** `tagName.class#id` of the topmost element there. */
  readonly topmost: string;
  /** True when the topmost element is the target or inside it. */
  readonly reachesTarget: boolean;
  /** The first ancestor that sets `pointer-events: none`, if any. */
  readonly blockedBy: string | null;
};

/**
 * What would actually receive a click at the centre of `selector`.
 *
 * `elementFromPoint` is the honest question. A test that merely clicks and
 * asserts the consequence can pass for the wrong reason — Playwright's click
 * reports success as long as *something* took the event — and a test that
 * asserts visibility says nothing at all about input.
 */
export async function hitTestCentre(page: Page, selector: string): Promise<HitTest> {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) throw new Error(`No element matches ${target}`);
    const box = element.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    const describe = (node: Element | null): string => {
      if (node === null) return "(nothing)";
      const classes = typeof node.className === "string" && node.className.trim() !== ""
        ? `.${node.className.trim().split(/\s+/).join(".")}`
        : "";
      return `${node.tagName.toLowerCase()}${classes}${node.id ? `#${node.id}` : ""}`;
    };
    const topmost = document.elementFromPoint(x, y);
    // Name the wrapper responsible, so a failure says which element to fix
    // rather than only that the surface is dead.
    let blockedBy: string | null = null;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (getComputedStyle(node).pointerEvents === "none") {
        blockedBy = describe(node);
        break;
      }
    }
    return {
      x,
      y,
      topmost: describe(topmost),
      reachesTarget: topmost !== null && (topmost === element || element.contains(topmost)),
      blockedBy,
    };
  }, selector);
}

export type CanvasFrame = {
  readonly width: number;
  readonly height: number;
  /** Distinct RGB triples across the sampled pixels. */
  readonly distinctColours: number;
  /** Fraction of sampled pixels that are not pure black. */
  readonly nonBlackFraction: number;
  /** Fraction of sampled pixels with alpha 255. */
  readonly opaqueFraction: number;
  /** A digest of the sampled pixels, for comparing two frames. */
  readonly fingerprint: string;
};

/**
 * Read pixels back from exactly one canvas, identified by its host element.
 *
 * `hostSelector` names the element that owns the scene (for the 3D world,
 * `div[data-testid=scenario-world-host]`) and the canvas is taken from
 * *inside* it. That indirection is the point: the page also carries a
 * decorative WebGL canvas, and a plain `page.locator("canvas").first()`
 * produced a false "the scene is frozen" report today. This throws rather
 * than guessing when the host holds no canvas or more than one.
 */
export async function readCanvasFrame(page: Page, hostSelector: string): Promise<CanvasFrame> {
  return page.evaluate((selector) => {
    const host = document.querySelector(selector);
    if (host === null) throw new Error(`No element matches ${selector}`);
    const canvases = [...host.querySelectorAll("canvas")];
    if (canvases.length === 0) throw new Error(`${selector} contains no canvas`);
    if (canvases.length > 1) {
      throw new Error(
        `${selector} contains ${canvases.length} canvases; name the one to read rather than sampling an arbitrary canvas`,
      );
    }
    const canvas = canvases[0]!;
    const readback = document.createElement("canvas");
    readback.width = canvas.width;
    readback.height = canvas.height;
    const context = readback.getContext("2d");
    if (context === null) throw new Error("No 2D context for readback");
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, readback.width, readback.height);

    // Sample on a stride: a 960x558 canvas is half a million pixels and the
    // question ("is there a picture here") does not need all of them.
    const stride = Math.max(1, Math.floor(Math.sqrt((data.length / 4) / 20_000)));
    const colours = new Set<number>();
    let sampled = 0;
    let nonBlack = 0;
    let opaque = 0;
    let hash = 0x811c9dc5;
    for (let pixel = 0; pixel < data.length / 4; pixel += stride) {
      const offset = pixel * 4;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      const a = data[offset + 3]!;
      sampled += 1;
      if (r !== 0 || g !== 0 || b !== 0) nonBlack += 1;
      if (a === 255) opaque += 1;
      colours.add((r << 16) | (g << 8) | b);
      hash = Math.imul(hash ^ r, 0x01000193) >>> 0;
      hash = Math.imul(hash ^ g, 0x01000193) >>> 0;
      hash = Math.imul(hash ^ b, 0x01000193) >>> 0;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      distinctColours: colours.size,
      nonBlackFraction: sampled === 0 ? 0 : nonBlack / sampled,
      opaqueFraction: sampled === 0 ? 0 : opaque / sampled,
      fingerprint: hash.toString(16).padStart(8, "0"),
    };
  }, hostSelector);
}
