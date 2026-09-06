/**
 * Site matching over a loaded bundle: `template × map → ranked MatchReport`.
 *
 * The matcher runs natively (`matchSites` on the native module, which adapts
 * the template's anchor/roles, scores candidate frames and filters sites whose
 * required map controls are not executable). These are the host-neutral
 * `*With(module, …)` entries; `./sites` binds them to the N-API runtime and
 * adds installed-map lookup.
 */

import type { NativeModule } from '@simforge-oss/engine';
import type { ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { guard } from '@simforge-oss/native-runtime/shared';

import type { MatchReport } from './anchor/index.js';
import type { MapBundle } from './types.js';

/** One dropped or rewritten anchor clause reported by the native template adapter. */
export interface AdaptNote {
  readonly path: string;
  readonly reason: string;
  readonly severity: 'note' | 'error';
  readonly code?: string;
}

export interface SiteMatch<B extends MapBundle = MapBundle> {
  readonly mapId: string;
  readonly bundle: B;
  readonly report: MatchReport;
  /** Anchor clauses the adapter dropped or rewrote before matching. */
  readonly notes: readonly AdaptNote[];
}

export interface SiteMatchOptions {
  readonly minScore?: number | undefined;
  readonly maxSites?: number | undefined;
  /** Use the catalog's lossless persisted-site replay policy. */
  readonly exactCatalogSiteResolution?: boolean | undefined;
}

/** The anchor clauses the native adapter would drop or rewrite before matching, without a map. */
export function adaptTemplateNotesWith(module: NativeModule, template: ScenarioTemplateV2): AdaptNote[] {
  return JSON.parse(guard(() => module.adaptTemplateNotesJson(JSON.stringify(template)))) as AdaptNote[];
}

/** Match one template against an already-loaded bundle. */
export function matchSitesWith<B extends MapBundle>(module: NativeModule, template: ScenarioTemplateV2, bundle: B, options: SiteMatchOptions = {}): SiteMatch<B> {
  const optionsJson = Object.keys(options).length === 0 ? null : JSON.stringify(options);
  const raw = JSON.parse(guard(() => module.matchSites(JSON.stringify(template), bundle.native, optionsJson))) as Omit<SiteMatch, 'bundle'>;
  return { ...raw, bundle };
}
