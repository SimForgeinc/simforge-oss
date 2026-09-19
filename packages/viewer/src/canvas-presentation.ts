/** True only after CSS can present the canvas without an unfinished opacity reveal. */
export function canvasIsPresentable(canvas: HTMLCanvasElement): boolean {
  if (!canvas.isConnected || canvas.width <= 0 || canvas.height <= 0) return false;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  for (let element: HTMLElement | null = canvas; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || (style.opacity !== '' && Number(style.opacity) <= 0)) return false;
    // The class can already say opacity-100 while the computed value is still
    // zero. Wait for the real CSS transition, including reduced-motion's
    // no-transition path, rather than duplicating its duration in a timer.
    if (element.getAnimations?.().some(animation =>
      'transitionProperty' in animation && animation.transitionProperty === 'opacity'
      && (animation.playState === 'running' || animation.pending))) return false;
  }
  return true;
}

/**
 * Wait through a visible browser paint before announcing readiness. A resource
 * promise, React state update, or first RAF alone precedes that paint. The
 * caller cancels this lifetime-scoped wait on replacement, hide or teardown.
 */
export function waitForCanvasPresentation(canvas: HTMLCanvasElement, onPresented: () => void): () => void {
  let frame = 0;
  let visibleLastFrame = false;
  const inspect = () => {
    const visible = canvasIsPresentable(canvas);
    if (visible && visibleLastFrame) {
      onPresented();
      return;
    }
    visibleLastFrame = visible;
    frame = requestAnimationFrame(inspect);
  };
  frame = requestAnimationFrame(inspect);
  return () => cancelAnimationFrame(frame);
}
