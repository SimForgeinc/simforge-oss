"use client";

import { useEffect, useState, type RefObject } from "react";

export type ScrollEdges = {
  /** Content is hidden above the scroller's top edge. */
  above: boolean;
  /** Content is hidden below the scroller's bottom edge. */
  below: boolean;
};

/**
 * Whether a vertical scroller has more content past either edge, kept current as it scrolls,
 * resizes or its content changes. Drives the fade that tells a user a list scrolls when the
 * platform hides idle scrollbars (macOS overlay scrollbars, touch).
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ above: false, below: false });
  useEffect(() => {
    const scroller = ref.current;
    if (scroller === null) return;
    const update = () => {
      const above = scroller.scrollTop > 0;
      // One pixel of slack: fractional layout can leave scrollTop a sub-pixel short of the end.
      const below = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
      setEdges((current) => (current.above === above && current.below === below ? current : { above, below }));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    // Environments without layout (jsdom) have neither observer; the scroll listener still works.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(scroller);
    const content = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    content?.observe(scroller, { childList: true, subtree: true });
    return () => {
      scroller.removeEventListener("scroll", update);
      resize?.disconnect();
      content?.disconnect();
    };
  }, [ref]);
  return edges;
}
