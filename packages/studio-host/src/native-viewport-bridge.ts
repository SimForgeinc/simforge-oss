import type { NativeViewportBridge, NativeViewportEvent } from './desktop-map-cache';

export type NativeViewportProcessPort = {
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  start(): Promise<unknown>;
  send(command: Record<string, unknown>): void;
  stop(): void;
};

/** Adapts the typed Electron capability to the process-shaped viewer adapter. */
export function nativeViewportProcessPort(bridge: NativeViewportBridge): NativeViewportProcessPort {
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
      if (command.command === 'camera') {
        void bridge.camera(command.position as readonly number[], command.target as readonly number[]);
      } else if (command.command === 'quit') {
        void bridge.stop();
      } else {
        throw new Error(`native viewport command is not supported by this bridge: ${String(command.command)}`);
      }
    },
    stop: () => bridge.stop(),
  };
}
