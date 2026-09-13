import type { SimScenarioInput } from '@simforge-oss/engine';

import type { AuthoredDriveMode, ManualDriveRecording } from './authored-world-session';
import type { ControlInput, DriverCommand, SpawnActorRequest } from './types';

export type LiveWorldWorkerRequest =
  | { type: 'init'; mapManifestUrl: string; laneGraphUrl?: string; tickHz: number }
  | {
      type: 'init-authored';
      input: SimScenarioInput;
      laneGraphUrl: string;
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
  | { type: 'take-complete'; recording: ManualDriveRecording }
  | { type: 'take-failed'; message: string }
  /** The world was rebuilt at t = 0; every following `frame` restarts from tick 0. */
  | { type: 'world-reset'; generation: number }
  | { type: 'frame'; bytes: ArrayBuffer }
  | { type: 'transport'; playing: boolean; inspecting: boolean; completed: boolean; time: number; duration: number }
  | { type: 'result'; requestId: number; actorId?: string }
  | { type: 'error'; message: string; requestId?: number }
  | { type: 'warning'; message: string };
