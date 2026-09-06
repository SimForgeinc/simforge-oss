/**
 * `@simforge-oss/compiler/node` — the compiler bound to the N-API runtime.
 *
 * Map loading, site matching, template/situation compilation and rehearsal all
 * execute in the native compiler through `@simforge-oss/engine/node`.
 */

import type { ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { engine } from '@simforge-oss/engine/node';

import type { MatchedSite } from './anchor/index.js';
import {
  cellSeedWith,
  compileTemplateWith,
  findSitesWith,
  templateIdentityWith,
  type CompiledTemplate,
  type MaterializeOptions,
  type TemplateIdentity,
} from './materialize.js';
import type { MapBundle } from './types.js';

export * from './index.js';
export * from './maps.js';
export * from './template-io.js';
export * from './sites.js';
export * from './execution-package.js';
export { createMapContext } from './map-context.js';
export {
  compareSituation,
  compileSituation,
  rehearsalScenario,
  rehearseSituation,
  solveSituation,
} from './situation.js';

/** Materialise `template × bundle × site × seed` natively. `site` is a site id, a matched site, or `null` for the top-ranked site. */
export function compileTemplate(template: ScenarioTemplateV2, bundle: MapBundle, site: string | MatchedSite | null, options: MaterializeOptions = {}): CompiledTemplate {
  return compileTemplateWith(engine().module, template, bundle, site, options);
}

/** Site ids in `bundle` that satisfy the template's anchor, ranked by the native matcher. */
export function findSites(template: ScenarioTemplateV2, bundle: MapBundle): string[] {
  return findSitesWith(engine().module, template, bundle);
}

/** `{templateId, paramsVersion}`: the replay-key identity the native manifest stamps. */
export function templateIdentity(template: ScenarioTemplateV2): TemplateIdentity {
  return templateIdentityWith(engine().module, template);
}

/** `sha256(templateId|paramsVersion|siteId|drawIndex)`: a cell's parameter seed, as the native compiler derives it. */
export function cellSeed(templateId: string, paramsVersion: string, siteId: string, drawIndex: number): string {
  return cellSeedWith(engine().module, templateId, paramsVersion, siteId, drawIndex);
}
