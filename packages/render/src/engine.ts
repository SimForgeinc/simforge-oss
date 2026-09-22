import type { RenderIntentV1 } from '@simforge-oss/scenario';

import type { RenderArtifactManifest } from './artifacts.js';
import { EngineCapabilityDeclarationSchema, type EngineCapabilityDeclaration } from './capabilities.js';
import type { RenderProgressRecord } from './progress.js';
import type { FixedSchedule } from './schedule.js';

export interface RenderInputFile {
  readonly inputId: string;
  readonly path: string;
  readonly relativePath?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RenderExecutionContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly intent: RenderIntentV1;
  readonly intentSha256: string;
  readonly executionPackageControlSha256: string;
  readonly schedules: readonly FixedSchedule[];
  readonly inputs: ReadonlyMap<string, RenderInputFile>;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly reportProgress: (record: RenderProgressRecord) => Promise<void>;
}

/** Declared input metadata an engine may inspect before any bulk download. */
export interface RenderInputDescriptor {
  readonly inputId: string;
  readonly relativePath?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RenderInputSelectionContext {
  readonly intent: RenderIntentV1;
  readonly inputs: readonly RenderInputDescriptor[];
  /** Fetches (through the worker cache) and returns one small input's bytes. */
  readonly read: (inputId: string) => Promise<Buffer>;
  readonly signal: AbortSignal;
}

/**
 * The only backend plug-in boundary. Adapters must either return a validated
 * manifest for real files or throw; there is no successful empty/default path.
 */
export interface RenderEngineAdapter {
  readonly capabilities: EngineCapabilityDeclaration;
  execute(context: RenderExecutionContext): Promise<RenderArtifactManifest>;
  close?(): Promise<void>;
  /**
   * The claimed inputs this intent actually renders from. The worker fetches
   * only these and `execute` receives only these; claimed inputs outside the
   * set stay declared (the intent hash still binds them) but are never
   * downloaded. Omitted: every claimed input is delivered.
   */
  selectInputs?(context: RenderInputSelectionContext): Promise<ReadonlySet<string>>;
  /**
   * `cache`: `execute` reads inputs in place from the worker's read-only,
   * content-addressed cache (no per-job copy). `workspace` (default): each
   * input is linked or copied under the job workspace, for engines that hand
   * the workspace to another container or process.
   */
  readonly inputPlacement?: 'workspace' | 'cache';
}

export type RenderEngineAdapterModule = {
  createRenderEngine(options: Readonly<Record<string, unknown>>): Promise<RenderEngineAdapter> | RenderEngineAdapter;
};

export async function loadRenderEngine(
  moduleSpecifier: string,
  options: Readonly<Record<string, unknown>> = {},
): Promise<RenderEngineAdapter> {
  if (moduleSpecifier.length === 0) throw new Error('engine module specifier is required');
  // Adapter selection is operator configuration, so the module cannot be statically imported.
  const imported = await import(moduleSpecifier) as Partial<RenderEngineAdapterModule>;
  if (typeof imported.createRenderEngine !== 'function') {
    throw new TypeError(`${moduleSpecifier} must export createRenderEngine(options)`);
  }
  const adapter = await imported.createRenderEngine(options);
  if (!adapter || typeof adapter.execute !== 'function' || !adapter.capabilities) {
    throw new TypeError(`${moduleSpecifier} returned an invalid render engine adapter`);
  }
  EngineCapabilityDeclarationSchema.parse(adapter.capabilities);
  return adapter;
}
