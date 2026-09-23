import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { addonCandidates, native } from '@simforge-oss/native-runtime';
import { compileTemplate, loadMap, matchOnMap, readTemplate, REPO_ROOT, type MatchedSite } from '@simforge-oss/compiler/node';
import type { SimScenarioInput } from '@simforge-oss/engine';
import {
  ScenarioSplitRequestSchema, ScenarioSplitSchema, parseScenarioSplit, scenarioSplitDigest,
  splitSeeds, splitDrawIndex, verifyScenarioSplits,
  type ScenarioSplit, type ScenarioSplitProof, type SplitArtifact,
} from '@simforge-oss/scenario';
import { boolFlag, parseArgs, requireString } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';
import { rehearseSplitInput, removeSplitHazards, splitGeometryFindings, splitInputHash, splitSiteKey, type BenchWindowAdmission } from './scenario-split-admission.js';

interface SplitInstance {
  input: SimScenarioInput;
  provenance: {
    cell: number; seed: number; drawIndex: number; templateSha256: string; inputSha256: string;
    paramsSha256: string; site: string; compilerVersion: string; replayKey: unknown;
    params: unknown; parentInputSha256?: string;
  };
}
interface SplitEpisodes {
  version: 1; scenarioId: string;
  episode: { decisionHz: number };
  instances: SplitInstance[];
  provenance: { schema: 'simforge.scenario-split-episodes/v1'; splitId: string; splitManifest: string };
}
interface AdmissionRun {
  seed: number; drawIndex: number; inputSha256: string; paramsSha256?: string;
  geometry: { status: string; findings: string[] };
  occlusion: { status: string };
  solvability: { status: string };
  benchWindow?: BenchWindowAdmission;
}
interface AdmissionReceipt {
  schema: string; splitId: string; cell: number; templateSha256: string;
  compilerVersion: string; nativeAddonSha256: string; checks: string[];
  runs: AdmissionRun[]; evidence: SplitArtifact[]; siteKey?: string;
  status?: 'admitted' | 'excluded'; reason?: string | null;
  match?: { candidateCount: number; failureSummary: string; notes: unknown; site: MatchedSite | null };
  map?: { id: string; topologySha256: string; engineGraphDigest: string; matcherIndexDigest: string };
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function saveArtifact(root: string, name: string, value: unknown, gzip = false): Promise<SplitArtifact> {
  const plain = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  const bytes = gzip ? gzipSync(plain) : Buffer.from(plain);
  const file = path.resolve(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await readFile(file)).equals(bytes)) throw new Error(`refusing to replace frozen artifact ${file}; use a new split id`);
  }
  return { path: name, sha256: sha256(bytes) };
}

async function loadArtifact(root: string, artifact: SplitArtifact): Promise<Buffer> {
  const bytes = await readFile(path.resolve(root, artifact.path));
  if (sha256(bytes) !== artifact.sha256) throw new Error(`artifact digest mismatch: ${artifact.path}`);
  return bytes;
}

/** Verify manifests, exact file bytes and per-instance draw/provenance, without running or changing a world. */
export async function verifySplitArtifacts(file: string, split: ScenarioSplit): Promise<SplitEpisodes> {
  const root = path.dirname(file);
  const episodes = JSON.parse((await loadArtifact(root, split.materialization.episodes)).toString()) as SplitEpisodes;
  if (episodes.version !== 1 || episodes.provenance?.splitId !== split.splitId || episodes.provenance?.schema !== 'simforge.scenario-split-episodes/v1' || !Array.isArray(episodes.instances) || episodes.instances.length !== split.materialization.count) throw new Error(`${split.splitId}: episodes identity/count mismatch`);
  if (path.resolve(root, episodes.provenance.splitManifest) !== path.resolve(file)) throw new Error(`${split.splitId}: episodes manifest backlink mismatch`);
  const seen = new Set<string>();
  for (const proof of split.admission.proofs) {
    const receipt = JSON.parse((await loadArtifact(root, proof.receipt)).toString()) as AdmissionReceipt;
    if (receipt.cell !== proof.cell || receipt.status !== proof.status || receipt.splitId !== split.splitId || receipt.compilerVersion !== split.admission.compilerVersion || receipt.nativeAddonSha256 !== split.admission.nativeAddonSha256) throw new Error(`${split.splitId}: admission receipt identity mismatch`);
    if (receipt.schema !== (proof.checks.length === 4 ? 'simforge.scenario-admission/v2' : 'simforge.scenario-admission/v1') ||
        receipt.checks.join('/') !== proof.checks.join('/')) throw new Error(`${split.splitId}: admission check/version mismatch`);
    for (const artifact of receipt.evidence ?? []) await loadArtifact(root, artifact);
    const cell = split.cells[proof.cell]!;
    const source = await readFile(path.resolve(root, cell.template));
    if (sha256(source) !== receipt.templateSha256) throw new Error(`${split.splitId}: template digest mismatch`);
    const rows = episodes.instances.filter((entry) => entry.provenance?.cell === proof.cell);
    if (proof.status === 'excluded') {
      if (rows.length) throw new Error(`${split.splitId}: excluded cell ${proof.cell} was materialized`);
      continue;
    }
    if (!receipt.match?.site || receipt.match.site.siteId !== cell.site || proof.siteKey !== splitSiteKey(cell.map, receipt.match.site) || receipt.siteKey !== proof.siteKey) throw new Error(`${split.splitId}: map-intel site identity mismatch`);
    const bundle = await loadMap(cell.map);
    if (receipt.map?.id !== cell.map || sha256(bundle.native.topologyJson()) !== receipt.map.topologySha256 || bundle.graph.digest !== receipt.map.engineGraphDigest || bundle.index.topologyDigest !== receipt.map.matcherIndexDigest) throw new Error(`${split.splitId}: installed map provenance mismatch`);
    const seeds = splitSeeds(cell);
    if (rows.length !== seeds.length || receipt.runs?.length !== seeds.length) throw new Error(`${split.splitId}: incomplete admitted cell ${proof.cell}`);
    const draws = new Set<number>(); const parameters = new Set<string>();
    const concretes = new Set<string>();
    for (let ordinal = 0; ordinal < seeds.length; ordinal++) {
      const row = rows[ordinal]!; const p = row.provenance;
      if (p.seed !== seeds[ordinal] || p.drawIndex !== splitDrawIndex(cell, p.seed, ordinal) || p.drawIndex < 0 || draws.has(p.drawIndex)) throw new Error(`${split.splitId}: invalid/repeated draw in cell ${proof.cell}`);
      draws.add(p.drawIndex);
      if (p.site !== cell.site || row.input.mapId !== cell.map || p.templateSha256 !== receipt.templateSha256 || splitInputHash(row.input) !== p.inputSha256 || splitInputHash(p.params) !== p.paramsSha256) throw new Error(`${split.splitId}: instance provenance mismatch in cell ${proof.cell}`);
      if (parameters.has(p.paramsSha256)) throw new Error(`${split.splitId}: repeated physical parameter draw in cell ${proof.cell}`);
      parameters.add(p.paramsSha256);
      const concrete = splitInputHash({ ...row.input, seed: 0 });
      if (split.purpose !== 'control' && concretes.has(concrete)) throw new Error(`${split.splitId}: repeated concrete differing only by seed in cell ${proof.cell}`);
      concretes.add(concrete);
      const witness = receipt.runs[ordinal]!;
      if (witness.seed !== p.seed || witness.inputSha256 !== p.inputSha256 || witness.drawIndex !== p.drawIndex || witness.geometry.status !== 'passed' || witness.occlusion.status !== 'passed' || witness.solvability.status !== 'passed') throw new Error(`${split.splitId}: admission witness mismatch`);
      if (proof.checks.length === 4) {
        const window = witness.benchWindow;
        const expectedOnsets = (row.input.occlusionPairs ?? []).length + (row.input.interactions ?? []).filter((interaction) => interaction.verb === 'changeLane' && interaction.actorId !== (row.input.metricSubject ?? 'ego')).length;
        if (!window || window.schema !== 'simforge.bench-window-admission/v1' || window.status !== 'passed' || window.minimumS !== 9.3 || window.prologueS !== 6.3 || window.reactionMarginS !== 3 ||
            !Number.isFinite(window.authoredDefaultGoals?.timing?.simulationS) || !Number.isFinite(window.benchContinuation?.timing?.simulationS) ||
            window.authoredDefaultGoals.timing.simulationS + 1e-6 < window.minimumS || window.benchContinuation.timing.simulationS + 1e-6 < window.minimumS ||
            !Array.isArray(window.hazardOnsets) || window.hazardOnsets.length !== expectedOnsets ||
            window.hazardOnsets.some((onset) => !Number.isFinite(onset.tS) || onset.tS === null || onset.tS + 1e-6 < window.minimumS)) throw new Error(`${split.splitId}: bench prologue/reaction-window admission mismatch`);
      }
      const identity = `${cell.map}/${cell.site}/${p.seed}`;
      if (seen.has(identity)) throw new Error(`${split.splitId}: duplicate materialized identity ${identity}`);
      seen.add(identity);
    }
  }
  return episodes;
}

export async function materializeScenarioSplit(file: string): Promise<ScenarioSplit> {
  file = path.resolve(file);
  const root = path.dirname(file);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  // Frozen products are immutable: a repeat verifies them, it never replaces prior evidence.
  if (raw.digest !== undefined) {
    const frozen = parseScenarioSplit(raw);
    await verifySplitArtifacts(file, frozen);
    return frozen;
  }
  const request = ScenarioSplitRequestSchema.parse(raw);
  if ((request.purpose === 'control') !== Boolean(request.pairedWith)) throw new Error('control requires an explicit paired test manifest; other purposes cannot be paired');
  let parent: { split: ScenarioSplit; episodes: SplitEpisodes } | undefined;
  if (request.pairedWith) {
    const parentFile = path.resolve(root, request.pairedWith.manifest);
    const split = parseScenarioSplit(JSON.parse(await readFile(parentFile, 'utf8')));
    if (split.purpose !== 'test' || split.splitId !== request.pairedWith.splitId || split.digest !== request.pairedWith.digest) throw new Error('paired test split identity mismatch');
    parent = { split, episodes: await verifySplitArtifacts(parentFile, split) };
  }
  const addon = addonCandidates()[0];
  if (!addon) throw new Error('native compiler addon unavailable');
  const nativeAddonSha256 = sha256(await readFile(addon));
  const compilerVersion = native().engineVersion();
  const frozenCells = [];
  const proofs: ScenarioSplitProof[] = [];
  const episodes: SplitEpisodes = {
    version: 1, scenarioId: request.splitId, episode: { decisionHz: 10 }, instances: [],
    provenance: { schema: 'simforge.scenario-split-episodes/v1', splitId: request.splitId, splitManifest: path.basename(file) },
  };
  for (let cellIndex = 0; cellIndex < request.cells.length; cellIndex++) {
    const cell = request.cells[cellIndex]!;
    const source = await readFile(path.resolve(root, cell.template));
    const templateSha256 = sha256(source);
    const template = await readTemplate(path.resolve(root, cell.template));
    const templateName = path.basename(cell.template, '.json').replace(/-[0-9a-f]{12}$/, '');
    const frozenTemplate = await saveArtifact(root, `templates/${templateName}-${templateSha256.slice(0, 12)}.json`, source.toString());
    frozenCells.push({ ...cell, template: frozenTemplate.path });
    const stem = `${request.splitId}/cell-${String(cellIndex).padStart(3, '0')}`;
    const receipt: AdmissionReceipt = { schema: 'simforge.scenario-admission/v2', splitId: request.splitId, cell: cellIndex, templateSha256, compilerVersion, nativeAddonSha256, checks: ['geometry', 'occlusion', 'solvability', 'bench-window'], runs: [], evidence: [] };
    let reason: string | undefined;
    let siteKey: string | undefined;
    const rows: SplitInstance[] = [];
    try {
      const match = await matchOnMap(template, cell.map);
      const site = match.report.sites.find((candidate) => candidate.siteId === cell.site);
      receipt.match = { candidateCount: match.report.sites.length, failureSummary: match.report.failureSummary, notes: match.notes, site: site ?? null };
      receipt.map = { id: cell.map, topologySha256: sha256(match.bundle.native.topologyJson()), engineGraphDigest: match.bundle.graph.digest, matcherIndexDigest: match.bundle.index.topologyDigest };
      if (!site) throw new Error(match.report.failureSummary || `requested site ${cell.site} is not in the unmodified native match report`);
      if (match.notes.some((note) => note.severity === 'error')) throw new Error('native anchor adapter reported a semantic error');
      siteKey = splitSiteKey(cell.map, site);
      receipt.siteKey = siteKey;
      if (parent && parent.split.admission.proofs.find((proof) => proof.cell === cellIndex)?.status !== 'admitted') throw new Error('paired test cell was excluded; no unpaired control admitted');
      const seeds = splitSeeds(cell);
      const physicalDraws = new Set<string>();
      const concretes = new Set<string>();
      for (let ordinal = 0; ordinal < seeds.length; ordinal++) {
        const seed = seeds[ordinal]!;
        const drawIndex = splitDrawIndex(cell, seed, ordinal);
        const compiled = compileTemplate(template, match.bundle, site, { seed: String(seed), drawIndex });
        const geometry = splitGeometryFindings(site, compiled);
        const paramsSha256 = splitInputHash(compiled.manifest.params);
        if (compiled.manifest.replayKey.drawIndex !== drawIndex || physicalDraws.has(paramsSha256)) geometry.push('compiler produced a repeated/default parameter draw');
        physicalDraws.add(paramsSha256);
        const concrete = splitInputHash({ ...compiled.input, seed: 0 });
        if (concretes.has(concrete)) geometry.push('compiler repeated a concrete differing only by seed');
        concretes.add(concrete);
        let input = compiled.input;
        let parentInputSha256: string | undefined;
        if (parent) {
          const paired = parent.episodes.instances.find((entry) => entry.provenance.cell === cellIndex && entry.provenance.seed === seed);
          if (!paired || paired.provenance.inputSha256 !== splitInputHash(input)) throw new Error('paired source does not exactly reproduce the test input');
          parentInputSha256 = paired.provenance.inputSha256;
          input = removeSplitHazards(input);
        }
        const inputSha256 = splitInputHash(input);
        if (geometry.length) {
          receipt.runs.push({ seed, drawIndex, inputSha256, geometry: { status: 'failed', findings: geometry }, occlusion: { status: 'not-run' }, solvability: { status: 'not-run' } });
          throw new Error(`seed ${seed}: ${geometry.join('; ')}`);
        }
        const rehearsal = await rehearseSplitInput(input, match.bundle, seed);
        receipt.runs.push({ seed, drawIndex, inputSha256, paramsSha256, ...rehearsal.receipt });
        if (ordinal === 0 || rehearsal.failures.length) {
          receipt.evidence.push(await saveArtifact(root, `receipts/${stem}-seed-${seed}.trace.json.gz`, rehearsal.trace, true));
          receipt.evidence.push(await saveArtifact(root, `receipts/${stem}-seed-${seed}.episode.jsonl.gz`, rehearsal.episodeTrace, true));
          receipt.evidence.push(await saveArtifact(root, `receipts/${stem}-seed-${seed}.default-goals.episode.jsonl.gz`, rehearsal.defaultGoalTrace, true));
          receipt.evidence.push(await saveArtifact(root, `receipts/${stem}-seed-${seed}.bench-window.episode.jsonl.gz`, rehearsal.benchEpisodeTrace, true));
        }
        if (rehearsal.failures.length) throw new Error(`seed ${seed}: ${rehearsal.failures.join('; ')}`);
        rows.push({ input, provenance: { cell: cellIndex, seed, drawIndex, inputSha256, paramsSha256, templateSha256, site: site.siteId, compilerVersion, replayKey: compiled.manifest.replayKey, params: compiled.manifest.params, ...(parentInputSha256 ? { parentInputSha256 } : {}) } });
      }
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    receipt.status = reason ? 'excluded' : 'admitted';
    receipt.reason = reason ?? null;
    const artifact = await saveArtifact(root, `receipts/${stem}.admission.json`, receipt);
    proofs.push({ cell: cellIndex, checks: ['geometry', 'occlusion', 'solvability', 'bench-window'], status: reason ? 'excluded' : 'admitted', ...(reason ? { reason: reason.slice(0, 512) } : {}), ...(siteKey ? { siteKey } : {}), receipt: artifact });
    if (!reason) episodes.instances.push(...rows);
  }
  const episodeArtifact = await saveArtifact(root, `${request.splitId}.episodes.json`, episodes);
  const document = {
    ...request, cells: frozenCells,
    admission: { proofs, generatedAt: new Date().toISOString(), compilerVersion, nativeAddonSha256 },
    materialization: { episodes: episodeArtifact, count: episodes.instances.length },
  };
  const split = ScenarioSplitSchema.parse({ ...document, digest: scenarioSplitDigest(document) });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(split, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
  return split;
}

export async function verifySplitFiles(files: readonly string[]) {
  const documents = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
  const splits = verifyScenarioSplits(documents);
  const episodes = await Promise.all(splits.map((split, index) => verifySplitArtifacts(path.resolve(files[index]!), split)));
  for (let i = 0; i < splits.length; i++) {
    const control = splits[i]!;
    if (!control.pairedWith) continue;
    const parentIndex = splits.findIndex((split) => split.splitId === control.pairedWith!.splitId);
    const parent = splits[parentIndex]!;
    if (control.cells.length !== parent.cells.length || control.materialization.count !== parent.materialization.count) throw new Error(`${control.splitId}: controls must pair every test episode exactly once`);
    for (const row of episodes[i]!.instances) {
      const source = episodes[parentIndex]!.instances.find((entry) => entry.provenance.cell === row.provenance.cell && entry.provenance.seed === row.provenance.seed);
      if (!source || row.provenance.parentInputSha256 !== source.provenance.inputSha256 || row.provenance.drawIndex !== source.provenance.drawIndex || row.provenance.paramsSha256 !== source.provenance.paramsSha256 || splitInputHash(removeSplitHazards(source.input)) !== row.provenance.inputSha256) throw new Error(`${control.splitId}: unpaired or incorrectly transformed control`);
    }
  }
  return { schema: 'simforge.scenario-split-verification/v1', valid: true, splits: splits.map((split) => ({ splitId: split.splitId, purpose: split.purpose, digest: split.digest, episodes: split.materialization.count, admittedCells: split.admission.proofs.filter((proof) => proof.status === 'admitted').length, excludedCells: split.admission.proofs.filter((proof) => proof.status === 'excluded').length })), independence: 'seed AND map-intel site; test/control geography held out from train/val', controls: 'digest-pinned one-to-one hazard removals of test; not an independent split' };
}

export async function scenariosCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: argv[0] === 'materialize' ? ['split'] : [] });
  if (argv[0] === 'materialize') {
    if (args.positionals.length) throw new CliError('bad_value', 'scenarios materialize takes --split <manifest>, not positional arguments');
    const split = await materializeScenarioSplit(requireString(args, 'split'));
    emit({ splitId: split.splitId, digest: split.digest, episodes: split.materialization.count, admittedCells: split.admission.proofs.filter((proof) => proof.status === 'admitted').length, excluded: split.admission.proofs.filter((proof) => proof.status === 'excluded').map((proof) => ({ cell: proof.cell, reason: proof.reason })) }, { pretty: boolFlag(args, 'pretty') });
    return EXIT.ok;
  }
  if (argv[0] === 'verify-splits') {
    let files = args.positionals;
    if (files.length === 1) {
      const reference = files[0]!;
      const directory = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reference)
        ? path.join(REPO_ROOT, 'qualification', 'training-splits', reference)
        : path.resolve(reference);
      if (!(await stat(directory)).isDirectory()) throw new CliError('bad_value', 'single verify-splits argument must be a split directory or frozen grid id');
      files = (await readdir(directory)).filter((name) => name.endsWith('.split.json')).sort().map((name) => path.join(directory, name));
    }
    if (files.length < 2) throw new CliError('bad_value', 'scenarios verify-splits requires a frozen grid id, directory, or two or more split manifests');
    emit(await verifySplitFiles(files), { pretty: boolFlag(args, 'pretty') });
    return EXIT.ok;
  }
  throw new CliError('unknown_command', 'Expected scenarios materialize --split <manifest> or scenarios verify-splits <a> <b>...');
}
