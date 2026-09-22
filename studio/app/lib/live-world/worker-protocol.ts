import type { SimScenarioInput } from '@simforge-oss/engine';
import type { MapGraphSources, StaticColliderDiagnostics } from '@simforge-oss/playback';

import type { AuthoredDriveMode, ManualDriveRecording } from './authored-world-session';
import type { ControlInput, DriveControlSource, DriverCommand, PlannerAction, SpawnActorRequest } from './types';

export type LiveWorldWorkerRequest =
  /**
   * Start the WASM engine and build the map's lane graph and colliders now,
   * while the page is still compiling the scenario. `init-authored` then only
   * waits for what is left. Optional: `init-authored` loads the map itself.
   */
  | { type: 'preload-map'; mapSources: MapGraphSources }
  | {
      type: 'init-authored';
      input: SimScenarioInput;
      /**
       * Published artifact URLs the world's lane graph is built from. The
       * graph carries the map's verified static colliders, so the drive
       * collides with the same structures the editor's preview does.
       */
      mapSources: MapGraphSources;
      tickHz: number;
      /**
       * Run past the document's clip length and never park. A game session has
       * no end to stop at; an editor preview does.
       */
      endless?: boolean;
    }
  | { type: 'spawn'; requestId: number; request: SpawnActorRequest }
  | { type: 'despawn'; requestId: number; actorId: string }
  | { type: 'set-ego'; actorId: string | null; mode?: AuthoredDriveMode }
  | { type: 'control'; input: ControlInput }
  | { type: 'driver-command'; actorId: string; command: DriverCommand | null }
  | { type: 'control-source'; source: DriveControlSource }
  | { type: 'planner-action'; actorId: string; action: PlannerAction }
  /** Rebuild the authored world at t = 0 and record the designated ego through the clip end. */
  | { type: 'begin-take' }
  | {
      type: 'transport';
      action: 'play' | 'stop' | 'reset' | 'playPause' | 'seek' | 'exitInspection';
      seconds?: number;
    }
  | { type: 'close' };

export type LiveWorldWorkerResponse =
  | { type: 'ready'; heldDriverCommand: boolean }
  /** What the map's verified static collision artifact contained. */
  | { type: 'map-collisions'; diagnostics: StaticColliderDiagnostics }
  | { type: 'take-complete'; recording: ManualDriveRecording }
  | { type: 'take-failed'; message: string }
  /** The world was rebuilt at t = 0; every following `frame` restarts from tick 0. */
  | { type: 'world-reset'; generation: number }
  | { type: 'frame'; bytes: ArrayBuffer }
  | { type: 'transport'; playing: boolean; inspecting: boolean; completed: boolean; time: number; duration: number }
  | { type: 'result'; requestId: number; actorId?: string }
  | { type: 'error'; message: string; requestId?: number }
  | { type: 'warning'; message: string };
