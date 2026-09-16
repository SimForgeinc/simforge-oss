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
  loadMap(input: { mapRoot: string; mapVersionId: string; releaseDigest: string }): Promise<void>;
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
