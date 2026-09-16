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

/** Adapts the typed Electron capability to the process-shaped viewer adapter. */
export function nativeViewportProcessPort(
  bridge: NativeViewportBridge,
  onError: (error: unknown) => void = () => {},
): NativeViewportProcessPort {
  return {
    onEvent(listener) {
      return bridge.onEvent((event: NativeViewportEvent) => listener({
        event: event.event,
        error: event.error ?? event.reason,
        map_version_id: event.map_version_id,
        release_digest: event.release_digest,
        elapsed_ms: event.elapsed_ms,
        recoverable: event.recoverable,
      }));
    },
    start: () => bridge.start(),
    send(command) {
      let operation: Promise<unknown>;
      if (command.command === 'camera') {
        operation = bridge.camera(vector3(command.position), vector3(command.target));
      } else if (command.command === 'quit') {
        operation = bridge.stop();
      } else {
        operation = Promise.reject(new Error(`native viewport command is not supported: ${String(command.command)}`));
      }
      void operation.catch(onError);
    },
    stop() { void bridge.stop().catch(onError); },
  };
}
