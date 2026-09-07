/** Elapsed visible time for UI work whose animation frames pause when hidden. */
export class VisibleClock {
  private readonly visibilityDocument = typeof document === "undefined" ? null : document;
  private visibleState = this.visibilityDocument?.visibilityState !== "hidden";
  private sampledAt = Date.now();
  private elapsed = 0;
  private readonly notify: () => void;

  constructor(onVisibilityChange: () => void) {
    this.notify = onVisibilityChange;
    this.visibilityDocument?.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  get visible(): boolean {
    return this.visibleState;
  }

  now(): number {
    return this.visibleState ? this.sample(Date.now()) : this.elapsed;
  }

  dispose(): void {
    this.visibilityDocument?.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private sample(at: number): number {
    if (this.visibleState) this.elapsed += Math.max(0, at - this.sampledAt);
    this.sampledAt = at;
    return this.elapsed;
  }

  private readonly handleVisibilityChange = () => {
    this.sample(Date.now());
    this.visibleState = this.visibilityDocument?.visibilityState !== "hidden";
    this.notify();
  };
}
