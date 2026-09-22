/**
 * Compiling at a known site. A pinned template (a transferred variation)
 * resolves only its own site, `compileTemplateAtSite` reuses that resolution
 * instead of matching again, and both give exactly the product the id-based
 * `compileTemplate` does. Requires installed map assets and the built N-API
 * addon.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  compileTemplate,
  compileTemplateAtSite,
  loadMap,
  matchSites,
  resolveSite,
} from '@simforge-oss/compiler/node';
import { parseTemplate, type ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { localMapAssetRequirement } from './asset-test-utils.js';

const MAP_ID = 'el-camino-road';
const assets = localMapAssetRequirement([MAP_ID]);

function example(): ScenarioTemplateV2 {
  return parseTemplate(JSON.parse(readFileSync(path.join(REPO_ROOT, 'examples/ltap-opposing.template.json'), 'utf8')));
}

function pinned(template: ScenarioTemplateV2, mapId: string, siteId: string): ScenarioTemplateV2 {
  return parseTemplate({ ...template, anchor: { ...template.anchor, pin: { mapId, siteId } } });
}

describe.skipIf(!assets.available)(`compile at a resolved site${assets.missingReason}`, () => {
  it('resolves a pinned site alone and compiles it exactly as compileTemplate does', async () => {
    const bundle = await loadMap(MAP_ID);
    const portable = example();
    const full = matchSites(portable, bundle, { maxSites: 24 });
    const site = full.report.sites.filter((s) => s.degradation.intentPreserved).at(-1);
    expect(site, full.report.failureSummary).toBeDefined();

    const document = pinned(portable, bundle.mapId, site!.siteId);
    const scoped = matchSites(document, bundle);
    expect(scoped.report.sites.map((s) => s.siteId)).toEqual([site!.siteId]);
    expect(scoped.report.sites[0]).toEqual(site);
    expect(scoped.report.stats.sitesScored).toBeLessThan(full.report.stats.sitesScored);

    const resolved = resolveSite(document, bundle, site!.siteId);
    expect(resolved.site).toEqual(site);
    const atSite = compileTemplateAtSite(document, bundle, resolved, { drawIndex: -1 });
    const byId = compileTemplate(document, bundle, site!.siteId, { drawIndex: -1 });
    expect(atSite.manifest).toEqual(byId.manifest);
    expect(atSite.input).toEqual(byId.input);
  }, 120_000);

  it('refuses a site resolved for a different template', async () => {
    const bundle = await loadMap(MAP_ID);
    const portable = example();
    const site = matchSites(portable, bundle, { maxSites: 1 }).report.sites[0]!;
    const resolved = resolveSite(portable, bundle, site.siteId);
    const other = parseTemplate({ ...portable, anchor: { ...portable.anchor, id: 'another-anchor' } });
    expect(() => compileTemplateAtSite(other, bundle, resolved)).toThrow(/site_mismatch|was not matched for this template/);
  }, 120_000);
});
