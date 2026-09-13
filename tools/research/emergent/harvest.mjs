#!/usr/bin/env node
/**
 * Arm (ii) harvest driver (rethink stream C).
 *
 * Why programmatic: the CLI never exposes `aggressiveness` / `speedVariance` /
 * `vehicleMix` — the aggressive/heterogeneous arm is only reachable through
 * `CellOptions.ambient` on `runCell` (same code the CLI batch runs per cell,
 * so semantics are identical; equivalence demonstrated in the pilot by
 * reproducing a CLI batch cell's traceDigest bit-for-bit).
 *
 *   node harvest.mjs plan --out <dir> [--seeds N] [--sites K] [--pilot]
 *   node harvest.mjs run  --out <dir> --shard I --shards N [--limit M]
 *
 * Layout (cell artifact contract, CONTRACTS §2):
 *   <out>/plan.json
 *   <out>/cells/<cellId>/{instance.json, trace.json.gz, result.json, meta.json}
 *   cellId = emergent-<runid>-<harvestId>-<map>-<site8>-0
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const CLI = await import(path.join(ROOT, 'packages/cli/dist/index.js'));

const TEMPLATES = {
  jS: path.join(HERE, 'templates/emergent-junction-straight.template.json'),
  jL: path.join(HERE, 'templates/emergent-junction-left.template.json'),
  ml: path.join(HERE, 'templates/emergent-multilane.template.json'),
  bo: path.join(HERE, 'templates/emergent-blackout.template.json'),
};
const MAPS = ['yale-street', 'belmont-research-center', 'el-camino-road'];

/** Registered harvest profiles. `heavy16` is CLI-expressible (equivalence anchor);
 * the other two are the aggressive/heterogeneous arms the CLI cannot express. */
const PROFILES = {
  heavy16: { version: 1, preset: 'heavy', maxActors: 48 },
  aggr24: {
    version: 1, preset: 'custom', densityVehiclesPerKm: 24, aggressiveness: 0.8,
    speedVariance: 0.35, maxActors: 64, pedestrianShare: 0, cyclistShare: 0.06,
    vehicleMix: { car: 0.6, van: 0.08, truck: 0.06, bus: 0.02, motorcycle: 0.24 },
  },
  dense32: {
    version: 1, preset: 'custom', densityVehiclesPerKm: 32, aggressiveness: 0.6,
    speedVariance: 0.25, maxActors: 64,
    vehicleMix: { car: 0.55, van: 0.12, truck: 0.18, bus: 0.09, motorcycle: 0.06 },
  },
};
const SETTLE_S = 20; // PREREG default, comparable with arm (i)

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(`--${name}`);

async function plan() {
  const out = arg('out');
  const seeds = Number(arg('seeds', 50));
  const seedFrom = Number(arg('seed-from', 1));
  const sitesPerMap = Number(arg('sites', 4));
  const pilot = has('pilot');
  const tplFilter = arg('templates', null)?.split(',');
  const configsFile = arg('configs', null); // stage 2: explicit config list
  const planName = arg('plan-name', 'plan.json');
  mkdirSync(path.join(out, 'cells'), { recursive: true });
  const runid = path.basename(out).replace(/^tgr-emergent-/, '');
  const entries = [];
  const siteTable = {};
  if (configsFile) {
    // Stage-2 depth: [{tplShort, mapId, siteId, profileId}] x seed range.
    const configs = JSON.parse(readFileSync(configsFile, 'utf8'));
    for (const c of configs) {
      const tplFile = TEMPLATES[c.tplShort];
      const templateSha256 = createHash('sha256')
        .update(readFileSync(tplFile)).digest('hex');
      for (let seed = seedFrom; seed <= seeds; seed += 1) {
        const harvestId = `${c.tplShort}.${c.profileId}.s${seed}`;
        entries.push({
          cellId: `emergent-${runid}-${harvestId}-${c.mapId}-${c.siteId.slice(0, 8)}-0`,
          tplShort: c.tplShort, tplFile, templateSha256, mapId: c.mapId,
          siteId: c.siteId, profileId: c.profileId, ambientSeed: `h${seed}`, seed,
        });
      }
    }
    writeFileSync(path.join(out, planName), JSON.stringify({
      runid, seeds, seedFrom, settleS: SETTLE_S, profiles: PROFILES,
      configs, nCells: entries.length, entries,
    }));
    console.log(JSON.stringify({ nCells: entries.length, configs: configs.length }));
    return;
  }
  for (const [tplShort, tplFile] of Object.entries(TEMPLATES)) {
    if (tplFilter && !tplFilter.includes(tplShort)) continue;
    const template = await CLI.readTemplate(tplFile);
    const templateSha256 = createHash('sha256')
      .update(readFileSync(tplFile)).digest('hex');
    for (const mapId of MAPS) {
      let matches;
      try {
        matches = await CLI.matchOnMaps(template, [mapId], { maxSites: sitesPerMap });
      } catch (e) {
        siteTable[`${tplShort}|${mapId}`] = { error: String(e.message ?? e) };
        continue;
      }
      const sites = matches.flatMap((m) => m.report.sites.map((s) => s.siteId));
      siteTable[`${tplShort}|${mapId}`] = { sites };
      for (const siteId of sites) {
        for (const [profileId, profile] of Object.entries(PROFILES)) {
          for (let seed = seedFrom; seed <= seeds; seed += 1) {
            const harvestId = `${tplShort}.${profileId}.s${seed}`;
            entries.push({
              cellId: `emergent-${runid}-${harvestId}-${mapId}-${siteId.slice(0, 8)}-0`,
              tplShort, tplFile, templateSha256, mapId, siteId,
              profileId, ambientSeed: `h${seed}`, seed,
            });
          }
        }
      }
    }
  }
  const sliced = pilot ? entries.filter((e) => e.seed <= 2) : entries;
  writeFileSync(path.join(out, planName), JSON.stringify({
    runid, seeds, seedFrom, sitesPerMap, settleS: SETTLE_S, profiles: PROFILES,
    maps: MAPS, siteTable, nCells: sliced.length, entries: sliced,
  }));
  console.log(JSON.stringify({ nCells: sliced.length, siteTable }, null, 1));
}

async function run() {
  const out = arg('out');
  const shard = Number(arg('shard', 0));
  const shards = Number(arg('shards', 1));
  const limit = Number(arg('limit', Infinity));
  const planData = JSON.parse(readFileSync(path.join(out, arg('plan-name', 'plan.json')), 'utf8'));
  const mine = planData.entries.filter((_, i) => i % shards === shard).slice(0, limit);
  const templates = new Map();
  let done = 0;
  for (const e of mine) {
    const cellDir = path.join(out, 'cells', e.cellId);
    const resultPath = path.join(cellDir, 'result.json');
    if (existsSync(path.join(cellDir, 'meta.json'))) { done += 1; continue; }
    mkdirSync(cellDir, { recursive: true });
    if (!templates.has(e.tplFile)) templates.set(e.tplFile, await CLI.readTemplate(e.tplFile));
    const t0 = Date.now();
    const result = await CLI.runCell(templates.get(e.tplFile), {
      mapId: e.mapId, siteId: e.siteId, drawIndex: 0,
      outDir: cellDir, writeTrace: true, filter: 'critical',
      ambient: { ...planData.profiles[e.profileId], seed: e.ambientSeed },
      ambientSettleSeconds: planData.settleS,
      artifactPaths: {
        instance: path.join(cellDir, 'instance.json'),
        trace: path.join(cellDir, 'trace.json.gz'),
        result: resultPath,
      },
    });
    const wallMs = Date.now() - t0;
    const meta = {
      cellId: e.cellId, harvestId: `${e.tplShort}.${e.profileId}.s${e.seed}`,
      stream: 'emergent', templateSha256: e.templateSha256,
      template: e.tplShort, profile: e.profileId,
      map: e.mapId, site: e.siteId, draw: 0, seed: e.ambientSeed,
      settleS: planData.settleS,
      gate: null, // filled by harvest_gate.py (frozen tg_gate)
      notes: `world-run harvest cell; band=${result.band}; ambient=${result.ambient?.actorCount ?? 0}`,
      wallMs, band: result.band, verdict: result.verdict, status: result.status,
      ambientActorCount: result.ambient?.actorCount ?? 0,
      nearSubjectAtT0: result.ambient?.nearSubjectAtT0 ?? 0,
      error: result.error ?? null,
    };
    writeFileSync(path.join(cellDir, 'meta.json'), JSON.stringify(meta, null, 1));
    done += 1;
    console.log(JSON.stringify({
      i: done, of: mine.length, cellId: e.cellId, band: result.band,
      amb: meta.ambientActorCount, near: meta.nearSubjectAtT0, wallMs,
    }));
  }
  console.log(JSON.stringify({ shard, shards, done }));
}

const cmd = process.argv[2];
if (cmd === 'plan') await plan();
else if (cmd === 'run') await run();
else { console.error('usage: harvest.mjs plan|run --out <dir> ...'); process.exit(1); }
