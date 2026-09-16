import type {
  CameraCommand,
  CameraStateReport,
  PickRequest,
  PickResult,
  RendererImplementation,
} from './renderer-contract';

export type RendererMode = 'web' | 'native' | 'auto';
export type NativeReadiness = 'starting' | 'manifest-ready' | 'coarse-ready' | 'interactive' | 'complete' | 'device-lost' | 'error';

export interface NativeViewportPort {
  readonly implementation: Extract<RendererImplementation, 'bevy-native'>;
  readonly mode: 'native';
  readonly readiness: NativeReadiness;
  /**
   * Load a map by immutable identity. Deliberately not a filesystem path: the
   * map root is a host location that page script must never receive, so the
   * desktop main process resolves it from this identity after verifying the
   * release digest against the studio's native-profile endpoint.
   */
  loadMap(input: { mapVersionId: string; releaseDigest: string }): Promise<void>;
  /** Position and size the native surface over the editor's viewport region. */
  resize(input: { width: number; height: number; pixelRatio: number; x?: number; y?: number }): void;
  setSelection(ids: readonly string[]): void;
  applyCamera(command: CameraCommand): void;
  cameraState(): CameraStateReport | null;
  pick(request: PickRequest): Promise<PickResult>;
  onReadiness(listener: (state: NativeReadiness, detail?: string) => void): () => void;
  dispose(): Promise<void>;
}

export function chooseRendererMode(requested: RendererMode, nativeAvailable: boolean): 'web' | 'native' {
  if (requested === 'web') return 'web';
  if (requested === 'native') {
    if (!nativeAvailable) throw new Error('native renderer requested but unavailable');
    return 'native';
  }
  return nativeAvailable ? 'native' : 'web';
}
