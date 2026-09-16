import type { CameraCommand, CameraStateReport, PickRequest, PickResult } from './renderer-contract';
import type { NativeReadiness, NativeViewportPort } from './native-renderer-adapter';

type NativeProcess = {
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  start(): Promise<Record<string, unknown>>;
  setCamera(position: readonly number[], target: readonly number[]): void;
  stop(): void;
};

export class NativeProcessRenderer implements NativeViewportPort {
  readonly implementation = 'bevy-native' as const;
  readonly mode = 'native' as const;
  private state: NativeReadiness = 'starting';
  private readonly listeners = new Set<(state: NativeReadiness, detail?: string) => void>();
  private readonly process: NativeProcess;
  private camera: CameraStateReport | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(process: NativeProcess) {
    this.process = process;
    this.unsubscribe = process.onEvent((event) => {
      const kind = event.event;
      if (kind === 'manifest-ready' || kind === 'coarse-ready' || kind === 'interactive' || kind === 'device-lost' || kind === 'error' || kind === 'closed') {
        const state = kind === 'closed' ? 'error' : kind as NativeReadiness;
        this.state = state;
        for (const listener of this.listeners) listener(state, typeof event.error === 'string' ? event.error : undefined);
      }
    });
  }

  get readiness(): NativeReadiness { return this.state; }

  async loadMap(input: { mapRoot: string; mapVersionId: string; releaseDigest: string }): Promise<void> {
    this.state = 'starting';
    await this.process.start();
  }

  applyCamera(command: CameraCommand): void {
    if (command.kind !== 'set-pose') throw new Error(`native viewport does not yet support camera command ${command.kind}`);
    this.process.setCamera(command.pose.position, command.pose.target);
  }

  cameraState(): CameraStateReport | null { return this.camera; }

  async pick(_request: PickRequest): Promise<PickResult> {
    throw new Error('native viewport picking is not available until the interactive pick IPC is connected');
  }

  onReadiness(listener: (state: NativeReadiness, detail?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.process.stop();
    this.state = 'error';
  }
}
