import type { CameraCommand, CameraStateReport, PickHit, PickLayer, PickRequest, PickResult } from './renderer-contract';
import type { NativeReadiness, NativeViewportPort } from './native-renderer-adapter';

type NativeProcess = {
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  start(): Promise<unknown>;
  send(command: Readonly<Record<string, unknown>>): void;
  stop(): void;
};

const READINESS: Record<string, NativeReadiness> = {
  starting: 'starting',
  'manifest-ready': 'manifest-ready',
  'coarse-ready': 'coarse-ready',
  interactive: 'interactive',
  complete: 'complete',
  'device-lost': 'device-lost',
  error: 'error',
  // The host process synthesises `closed` when the child exits; an exit the
  // editor did not ask for is a renderer failure.
  closed: 'error',
};

type NativeCamera = {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fovYRad: number;
  aspect: number;
  nearM: number;
  farM: number;
};

/**
 * The editor's view of the native viewport process.
 *
 * Three things this class is responsible for that a thinner adapter got
 * wrong:
 *
 * 1. `loadMap` transmits identity to the process instead of only starting it,
 *    so switching maps is a command rather than a process restart, and the
 *    process can reject a release digest the host did not verify.
 * 2. Picks are rays derived from the *renderer's* camera, which the process
 *    reports through `camera-state`. NDC alone cannot become a world ray, and
 *    a straight-down ray from an NDC-shaped origin hits the map only by luck.
 * 3. Readiness reflects what the process reports, including `complete` and
 *    `device-lost`, because the UI's fallback decision is made from it.
 */
export class NativeProcessRenderer implements NativeViewportPort {
  readonly implementation = 'bevy-native' as const;
  readonly mode = 'native' as const;
  private state: NativeReadiness = 'starting';
  private detail: string | undefined;
  private readonly listeners = new Set<(state: NativeReadiness, detail?: string) => void>();
  private readonly process: NativeProcess;
  private camera: NativeCamera | null = null;
  private pendingPick: { resolve(result: PickResult): void; reject(reason: Error): void } | null = null;
  private unsubscribe: (() => void) | null;
  private identity: { mapVersionId: string; releaseDigest: string } | null = null;

  constructor(process: NativeProcess) {
    this.process = process;
    this.unsubscribe = process.onEvent((event) => {
      const kind = event.event;
      if (kind === 'picked') {
        const pending = this.pendingPick;
        this.pendingPick = null;
        pending?.resolve({ hits: Array.isArray(event.hits) ? (event.hits as PickHit[]) : [] });
        return;
      }
      if (kind === 'camera-state') {
        const { position, target, fovYRad, aspect, nearM, farM } = event as Partial<NativeCamera>;
        if (
          Array.isArray(position) && position.length === 3 && Array.isArray(target) && target.length === 3
          && typeof fovYRad === 'number' && typeof aspect === 'number'
          && typeof nearM === 'number' && typeof farM === 'number'
        ) {
          this.camera = { position, target, fovYRad, aspect, nearM, farM };
        }
        return;
      }
      const state = typeof kind === 'string' ? READINESS[kind] : undefined;
      if (state) {
        const detail = typeof event.message === 'string' ? event.message : typeof event.reason === 'string' ? event.reason : undefined;
        this.state = state;
        this.detail = detail;
        // A failed renderer cannot answer a pick it already accepted; leaving
        // the promise pending is what makes the editor look hung.
        if (state === 'error' || state === 'device-lost') {
          const pending = this.pendingPick;
          this.pendingPick = null;
          pending?.reject(new Error(detail ?? `native viewport ${state}`));
        }
        for (const listener of this.listeners) listener(state, detail);
      }
    });
  }

  get readiness(): NativeReadiness { return this.state; }
  get readinessDetail(): string | undefined { return this.detail; }

  async loadMap(input: { mapVersionId: string; releaseDigest: string }): Promise<void> {
    if (!input.mapVersionId || !input.releaseDigest) throw new Error('native map load requires mapVersionId and releaseDigest');
    this.identity = { mapVersionId: input.mapVersionId, releaseDigest: input.releaseDigest };
    await this.process.start();
    this.process.send({ command: 'load-map', mapVersionId: input.mapVersionId, releaseDigest: input.releaseDigest });
  }

  applyCamera(command: CameraCommand): void {
    if (command.kind !== 'set-pose') throw new Error(`native viewport does not support ${command.kind}`);
    this.process.send({ command: 'camera', position: command.pose.position, target: command.pose.target });
  }

  /**
   * The renderer's own view and projection, rebuilt from the pose and
   * intrinsics it reported. The native process is the authority on what it is
   * drawing; this method converts, it does not decide.
   */
  cameraState(): CameraStateReport | null {
    const camera = this.camera;
    if (!camera) return null;
    return {
      pose: { position: camera.position, target: camera.target },
      intrinsics: {
        fovYDeg: (camera.fovYRad * 180) / Math.PI,
        aspect: camera.aspect,
        near: camera.nearM,
        far: camera.farM,
      },
      viewMatrix: viewMatrix(camera.position, camera.target),
      projectionMatrix: projectionMatrix(camera.fovYRad, camera.aspect, camera.nearM, camera.farM),
    };
  }

  /** Viewport size changed: reposition and resize the native surface. */
  resize(input: { width: number; height: number; pixelRatio: number; x?: number; y?: number }): void {
    this.process.send({ command: 'resize', ...input });
  }

  setSelection(ids: readonly string[]): void {
    this.process.send({ command: 'selection', ids: [...ids] });
  }

  async pick(request: PickRequest): Promise<PickResult> {
    if (!Number.isFinite(request.ndc.x) || !Number.isFinite(request.ndc.y)) throw new Error('native pick coordinates must be finite');
    if (this.pendingPick) throw new Error('native pick already pending');
    const camera = this.camera;
    if (!camera) throw new Error('native pick needs a camera pose; the viewport has not reported camera-state yet');
    const { origin, direction } = pickRay(camera, request.ndc);
    const layers: readonly PickLayer[] = request.layers ?? ['actors', 'ground', 'map-static'];
    // Executor form because this package's `lib` predates
    // `Promise.withResolvers`; the resolvers are stored, not nested.
    return new Promise<PickResult>((resolve, reject) => {
      this.pendingPick = { resolve, reject };
      try {
        this.process.send({ command: 'pointer-ray', origin, direction, layers: [...layers], maxHits: request.maxHits ?? 8 });
      } catch (error) {
        this.pendingPick = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onReadiness(listener: (state: NativeReadiness, detail?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingPick?.reject(new Error('native viewport disposed'));
    this.pendingPick = null;
    this.identity = null;
    this.camera = null;
    this.process.stop();
    this.state = 'error';
  }

  /** Identity the process was last asked to load; null before `loadMap`. */
  loadedIdentity(): { mapVersionId: string; releaseDigest: string } | null { return this.identity; }
}

/**
 * Build a world-space ray through an NDC point for a look-at camera.
 *
 * The native viewport reports its own pose, vertical FOV and aspect, so the
 * ray is derived from the projection the renderer is actually using rather
 * than from an assumption the editor makes about it. Right-handed, +y up,
 * matching both three.js and Bevy's glTF convention.
 */
export function pickRay(
  camera: { position: readonly [number, number, number]; target: readonly [number, number, number]; fovYRad: number; aspect: number },
  ndc: { x: number; y: number },
): { origin: [number, number, number]; direction: [number, number, number] } {
  const [px, py, pz] = camera.position;
  const forward = normalize([camera.target[0] - px, camera.target[1] - py, camera.target[2] - pz]);
  // A camera looking straight down has no usable "up" to cross with; the
  // scene's +z then plays that role, which is what look-at does too.
  const worldUp: [number, number, number] = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, worldUp));
  const up = cross(right, forward);
  const halfHeight = Math.tan(camera.fovYRad / 2);
  const halfWidth = halfHeight * camera.aspect;
  const direction = normalize([
    forward[0] + right[0] * ndc.x * halfWidth + up[0] * ndc.y * halfHeight,
    forward[1] + right[1] * ndc.x * halfWidth + up[1] * ndc.y * halfHeight,
    forward[2] + right[2] * ndc.x * halfWidth + up[2] * ndc.y * halfHeight,
  ]);
  return { origin: [px, py, pz], direction };
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(value: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 0)) throw new Error('native pick ray is degenerate: camera position and target coincide');
  return [value[0] / length, value[1] / length, value[2] / length];
}

/**
 * Column-major world→camera matrix for a right-handed look-at camera, in the
 * order `Matrix4.elements` uses, because that is what `Mat4` documents.
 */
function viewMatrix(position: readonly [number, number, number], target: readonly [number, number, number]): number[] {
  const forward = normalize([target[0] - position[0], target[1] - position[1], target[2] - position[2]]);
  const worldUp: [number, number, number] = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, worldUp));
  const up = cross(right, forward);
  // Camera looks down -z, so the third basis row is -forward.
  const back: [number, number, number] = [-forward[0], -forward[1], -forward[2]];
  const dot = (a: readonly [number, number, number]) => a[0] * position[0] + a[1] * position[1] + a[2] * position[2];
  return [
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right), -dot(up), -dot(back), 1,
  ];
}

/** Column-major perspective projection with WebGL depth range [-1, 1]. */
function projectionMatrix(fovYRad: number, aspect: number, near: number, far: number): number[] {
  const focal = 1 / Math.tan(fovYRad / 2);
  const depth = 1 / (near - far);
  return [
    focal / aspect, 0, 0, 0,
    0, focal, 0, 0,
    0, 0, (far + near) * depth, -1,
    0, 0, 2 * far * near * depth, 0,
  ];
}
