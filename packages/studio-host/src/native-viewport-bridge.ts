import type { NativeViewportBridge, NativeViewportEvent } from './desktop-map-cache';

export type NativeViewportProcessPort = {
  onEvent(listener: (event: Readonly<Record<string, unknown>>) => void): () => void;
  start(): Promise<unknown>;
  send(command: Readonly<Record<string, unknown>>): void;
  stop(): void;
};

function vector3(value: unknown): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('native viewport camera vector must contain three finite numbers');
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/**
 * Renderer-side adapter over the Electron `nativeViewport` IPC surface.
 *
 * Every protocol command the editor can issue has a transport here. A command
 * this adapter does not know must be rejected loudly rather than dropped: a
 * silently swallowed `pointer-ray` is how the pick promise stopped resolving
 * in the first place.
 *
 * `mapRoot` never appears in this file. The map root is a host filesystem
 * path, so the main process resolves it from the verified map identity; the
 * page passes identity only.
 */
export function nativeViewportProcessPort(
  bridge: NativeViewportBridge,
  onError: (error: unknown) => void = () => {},
): NativeViewportProcessPort {
  return {
    onEvent(listener) {
      return bridge.onEvent((event: NativeViewportEvent) => listener(event as unknown as Record<string, unknown>));
    },
    start: () => bridge.start(),
    send(command) {
      try {
        const name = String(command.command);
        let operation: Promise<unknown>;
        switch (name) {
          case 'load-map': {
            const { mapVersionId, releaseDigest } = command;
            if (typeof mapVersionId !== 'string' || !mapVersionId || typeof releaseDigest !== 'string' || !releaseDigest) {
              throw new Error('native viewport load-map needs a non-empty mapVersionId and releaseDigest');
            }
            operation = bridge.loadMap({ mapVersionId, releaseDigest });
            break;
          }
          case 'camera':
            operation = bridge.camera(vector3(command.position), vector3(command.target));
            break;
          case 'quit':
            operation = bridge.stop();
            break;
          default:
            operation = bridge.command(command);
            break;
        }
        void operation.catch(onError);
      } catch (error) {
        onError(error);
      }
    },
    stop() { void bridge.stop().catch(onError); },
  };
}
