/**
 * Bring `element` into view by scrolling one box: its nearest scrolling ancestor, by the least
 * distance (`block: "nearest"`). Nothing else moves.
 *
 * `Element.scrollIntoView` walks every scroll container up to the viewport, and an `overflow: hidden`
 * shell box counts as one. Expanding a map group with it scrolled the scenario page's pane shell:
 * the dataset rail and the column header slid under the top bar and the map left an empty band
 * below it, until a reload. Use this wherever a list follows a selection.
 */
export function revealInScroller(element: Element, scroller: Element | null = nearestScroller(element)): void {
  if (scroller === null) return;
  const box = element.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  const top = port.top + scroller.clientTop;
  const bottom = top + scroller.clientHeight;
  if (box.top < top) {
    scroller.scrollTop -= top - box.top;
  } else if (box.bottom > bottom) {
    // Taller than the port: show its start, never scroll its start out of view.
    scroller.scrollTop += Math.min(box.bottom - bottom, box.top - top);
  }
}

/** The closest ancestor that scrolls vertically on purpose (`overflow-y: auto | scroll`). */
export function nearestScroller(element: Element): Element | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}
