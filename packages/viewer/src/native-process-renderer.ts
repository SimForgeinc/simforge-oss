import type { CameraCommand, CameraStateReport, PickRequest, PickResult } from './renderer-contract';
import type { NativeReadiness, NativeViewportPort } from './native-renderer-adapter';

type NativeProcess = {
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  start(): Promise<unknown>;
  send(command: Readonly<Record<string, unknown>>): void;
  stop(): void;
};

export class NativeProcessRenderer implements NativeViewportPort {
  readonly implementation = 'bevy-native' as const;
  readonly mode = 'native' as const;
  private state: NativeReadiness = 'starting';
  private readonly listeners = new Set<(state: NativeReadiness, detail?: string) => void>();
  private readonly process: NativeProcess;
  private camera: CameraStateReport | null = null;
  private unsubscribe: (() => void) | null;

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
    if (!input.mapRoot || !input.mapVersionId || !input.releaseDigest) throw new Error('native map load requires mapRoot, mapVersionId, and releaseDigest');
    this.state = 'starting';
    await this.process.start();
  }

  applyCamera(command: CameraCommand): void {
    if (command.kind !== 'set-pose') throw new Error(`native viewport does not yet support camera command ${command.kind}`);
    this.process.send({ command: 'camera', position: command.pose.position, target: command.pose.target });
  }

  cameraState(): CameraStateReport | null { return this.camera; }
  async pick(_request: PickRequest): Promise<PickResult> { throw new Error('native viewport picking is not available'); }
  onReadiness(listener: (state: NativeReadiness, detail?: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async dispose(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = null; this.process.stop(); this.state = 'error'; }
}
