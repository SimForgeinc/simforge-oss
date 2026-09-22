/**
 * What the live-world worker does with a command that arrives before its world
 * exists.
 *
 * Building the world takes seconds (the WASM engine, the map's lane graph and
 * colliders), and the page does not stop living meanwhile: the window loses
 * and regains focus, the drive loop starts pushing pedals, a pause toggles the
 * transport. The worker used to answer every such command with an error —
 * "live world is not running" — and the page, which treats any worker error as
 * terminal, showed that instead of a drive even though the world came up a
 * moment later. A command sent while the world is starting is not a mistake;
 * it is early. This gate holds it until the world is up and then replays it.
 *
 * Commands that only state the latest intent (pedals, transport, ego, control
 * source) are coalesced: only the newest of each kind is kept, moved to the
 * end so the replay order is the order the page last expressed them in. A
 * boot of a minute at 60 pedal updates a second replays one pedal update.
 *
 * If the world fails to start, the failure itself is what the page must see;
 * commands after it are dropped rather than answered with a second, generic
 * error that would bury the real one.
 */

export type ReadyGateState = 'starting' | 'ready' | 'failed';

export type Admission = 'run' | 'held' | 'dropped';

export class WorkerReadyGate<T> {
  private phase: ReadyGateState = 'starting';
  private readonly held: { key: string | null; message: T }[] = [];

  /**
   * @param coalesceKey the kind of intent a message states, or null for a
   *   message that must be replayed exactly (it carries a request id, or it is
   *   an action rather than a state).
   * @param limit how many exact messages to hold before refusing more.
   */
  constructor(
    private readonly coalesceKey: (message: T) => string | null,
    private readonly limit = 256,
  ) {}

  get state(): ReadyGateState {
    return this.phase;
  }

  /**
   * `run`: handle it now. `held`: kept for the replay. `dropped`: the world
   * failed to start (and said so), or the hold is full.
   */
  admit(message: T): Admission {
    if (this.phase === 'ready') return 'run';
    if (this.phase === 'failed') return 'dropped';
    const key = this.coalesceKey(message);
    if (key !== null) {
      const index = this.held.findIndex((entry) => entry.key === key);
      if (index >= 0) this.held.splice(index, 1);
    } else if (this.held.filter((entry) => entry.key === null).length >= this.limit) {
      return 'dropped';
    }
    this.held.push({ key, message });
    return 'held';
  }

  /** The world is up: every held message, in replay order. Later ones run directly. */
  open(): T[] {
    this.phase = 'ready';
    return this.held.splice(0).map((entry) => entry.message);
  }

  /** The world could not start: forget what was held. Later messages are dropped. */
  fail(): void {
    this.phase = 'failed';
    this.held.length = 0;
  }
}
