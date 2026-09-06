/**
 * Site matching over installed maps: `template × map → ranked MatchReport`.
 *
 * The matcher itself is `./match` (host-neutral, over the native module); this
 * module binds it to the N-API runtime, memoises reports per
 * `(template, map, policy)` and resolves persisted site ids.
 */

import type { ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { engine } from '@simforge-oss/engine/node';

import type { MatchedSite } from './anchor/index.js';
import { CliError } from './errors.js';
import { loadMap } from './maps.js';
import { adaptTemplateNotesWith, matchSitesWith, type AdaptNote, type SiteMatch, type SiteMatchOptions } from './match.js';
import type { InstalledMapBundle, MapBundle } from './types.js';

/**
 * The catalog persists a concrete matcher-site id, rather than an instruction
 * to pick the best currently-visible site. Both catalog authoring and replay
 * therefore use this one policy: retain every otherwise-eligible exact site
 * (up to the schema's full cap) and never discard it for presentation diversity.
 */
export const CATALOG_EXACT_SITE_OPTIONS = {
  exactCatalogSiteResolution: true,
} as const;

const cache = new Map<string, SiteMatch<InstalledMapBundle>>();

/** Release retained matcher reports after bounded bulk verification work. */
export function clearSiteMatchCache(): void {
  cache.clear();
}

/** The anchor clauses the native adapter would drop or rewrite before matching, without a map. */
export function adaptTemplateNotes(template: ScenarioTemplateV2): AdaptNote[] {
  return adaptTemplateNotesWith(engine().module, template);
}

/** Match one template against an already-loaded bundle. */
export function matchSites<B extends MapBundle>(template: ScenarioTemplateV2, bundle: B, options: SiteMatchOptions = {}): SiteMatch<B> {
  return matchSitesWith(engine().module, template, bundle, options);
}

/** Match one template against one installed map. */
export async function matchOnMap(template: ScenarioTemplateV2, mapId: string, options: SiteMatchOptions = {}): Promise<SiteMatch<InstalledMapBundle>> {
  const key = `${mapId}|${JSON.stringify(template)}|${options.minScore ?? ''}|${options.maxSites ?? ''}|${options.exactCatalogSiteResolution ? 'catalog-exact' : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = matchSites(template, await loadMap(mapId), options);
  cache.set(key, result);
  return result;
}

/** Match across several maps, in the given order. */
export async function matchOnMaps(template: ScenarioTemplateV2, mapIds: readonly string[], options: SiteMatchOptions = {}): Promise<SiteMatch<InstalledMapBundle>[]> {
  const out: SiteMatch<InstalledMapBundle>[] = [];
  for (const mapId of mapIds) out.push(await matchOnMap(template, mapId, options));
  return out;
}

/** Find one site by id on a map. Stale ids still resolve from `rejected` and fail closed in the compiler. */
export async function findSite(
  template: ScenarioTemplateV2,
  mapId: string,
  siteId: string,
  options: SiteMatchOptions = {},
): Promise<{ bundle: InstalledMapBundle; site: MatchedSite }> {
  const match = await matchOnMap(template, mapId, { maxSites: 100, ...options });
  const site =
    match.report.sites.find((s) => s.siteId === siteId) ??
    match.report.rejected.find((s) => s.siteId === siteId);
  if (!site) {
    throw new CliError('unknown_site', `site "${siteId}" was not produced on ${mapId}`, {
      path: '--site',
      detail: {
        known: match.report.sites.map((s) => s.siteId),
        rejected: match.report.rejected.map((s) => s.siteId),
      },
    });
  }
  return { bundle: match.bundle, site };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The compact site view the CLI prints. */
export function siteSummary(site: MatchedSite): Record<string, unknown> {
  return {
    siteId: site.siteId,
    mapId: site.mapId,
    score: round3(site.score),
    verdict: site.degradation.verdict,
    intentPreserved: site.degradation.intentPreserved,
    origin: site.frame.origin.mapFeatureId,
    entryLaneRsl: site.frame.entryLaneRsl,
    egoTurn: site.frame.egoTurn ?? null,
    runwayUpstreamM: round3(site.frame.runwayUpstreamM),
    runwayDownstreamM: round3(site.frame.runwayDownstreamM),
    mirrored: site.frame.mirrored,
    alternateFrames: site.alternateFrames,
    degradation: {
      summary: site.degradation.summary,
      repairs: site.degradation.repairs.map((r) => ({ kind: r.kind, touchesRequired: r.touchesRequired, note: r.note })),
      failedRequiredClauses: site.degradation.failedRequiredClauses,
    },
    bindings: site.bindings.map((b) => ({
      role: b.role,
      kind: b.kind,
      status: b.status,
      laneRsl: b.laneRsl ?? null,
      routeLanes: b.routeLaneChain?.length ?? 0,
      conflict: b.conflict
        ? {
            gateId: b.conflict.gateId,
            crossingAngleDeg: round3(b.conflict.crossingAngleDeg),
            relation: b.conflict.relation,
            sOnEgo: round3(b.conflict.sOnEgo),
            sOnActor: round3(b.conflict.sOnActor),
          }
        : null,
      notes: b.notes,
    })),
    clauses: site.clauses.map((c) => ({
      path: c.path,
      essentiality: c.essentiality,
      score: round3(c.score),
      slack: round3(c.slack),
      supported: c.supported,
      required: c.required,
      actual: c.actual,
      reason: c.reason,
    })),
    matchedReasons: site.matchedReasons,
  };
}
