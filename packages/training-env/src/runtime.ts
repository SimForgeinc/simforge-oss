/**
 * `SessionRuntime` — the host-neutral factory for every native session kind.
 * Node binds it to the N-API addon (`./node.ts`), the browser to the
 * initialised WASM module (`./browser.ts`).
 */

import { EngineRuntime, type NativeModule } from '@simforge-oss/engine';

import { PolicySession, type PolicySessionOptions } from './policy-session.js';
import { EnvSession, SessionBatch, type EnvSessionOptions, type SessionBatchOptions } from './session.js';
import {
  WorldSession,
  replayWorldSessionLog,
  type ReplayResult,
  type WorldSessionLog,
  type WorldSessionOptions,
} from './world-session.js';

export class SessionRuntime {
  readonly engine: EngineRuntime;

  constructor(readonly module: NativeModule) {
    this.engine = new EngineRuntime(module);
  }

  env(options: EnvSessionOptions): EnvSession {
    return new EnvSession(this.module, this.engine, options);
  }

  batch(options: SessionBatchOptions): SessionBatch {
    return new SessionBatch(this.module, this.engine, options);
  }

  policy(options: PolicySessionOptions): PolicySession {
    return new PolicySession(this.module, this.engine, options);
  }

  world(options: WorldSessionOptions): WorldSession {
    return new WorldSession(this.module, this.engine, options);
  }

  replayWorldLog(log: WorldSessionLog, options: Pick<WorldSessionOptions, 'input' | 'graph'>): ReplayResult {
    return replayWorldSessionLog(this.module, this.engine, log, options);
  }
}
