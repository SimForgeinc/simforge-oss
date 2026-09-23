import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '@simforge-oss/engine';
import { parseScenarioSplit, type ScenarioSplit } from '@simforge-oss/scenario';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const panelIdPattern = /^[a-z0-9][a-z0-9-]*$/;
export const PanelSchema = z.strictObject({
  schema: z.literal('simforge.eval-panel/v1'),
  panelId: z.string().regex(panelIdPattern),
  /** New panels declare their grid size; older frozen documents pin it through their entry digest. */
  expectedEpisodes: z.number().int().positive().optional(),
  frozenAt: z.string(),
  selection: z.string(),
  timing: z.strictObject({ mode: z.literal('offline-simtime'), decisionHz: z.literal(10), replanHz: z.literal(2), warmupFrames: z.literal(64) }),
  statistics: z.strictObject({ bootstrapSeed: z.number().int(), bootstrapReplicates: z.literal(10000), confidence: z.literal(0.95), minimumCollisionReduction: z.literal(0.2), maximumCompletionLoss: z.literal(0.02), referenceRule: z.literal('mean >= reference - 1 SE') }),
  sources: z.array(z.strictObject({ purpose: z.enum(['test', 'control']), manifest: z.string(), manifestSha256: hash, splitDigest: hash, episodes: z.string(), episodesSha256: hash })).length(2),
  entries: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]+$/), source: z.enum(['test', 'control']), instance: z.number().int().nonnegative(), seed: z.number().int().nonnegative(), inputSha256: hash, mapId: z.string(), site: z.string(), durationS: z.number().positive(), pairId: z.string() })).min(2),
  digest: hash,
});
export type EvaluationPanel = z.infer<typeof PanelSchema>;
export type PanelEntry = EvaluationPanel['entries'][number];
export interface LoadedPanel { panel: EvaluationPanel; inputs: Map<string, unknown>; graphDigests: Map<string, string>; file: string }

export function panelDigest(value: Omit<EvaluationPanel, 'digest'> | EvaluationPanel): string {
  const { digest: _digest, ...document } = value as EvaluationPanel;
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}

/** Below the pre-registered 32-entry development-panel floor, evidence is screening only regardless of its name. */
export function isScreeningPanel(panel: EvaluationPanel): boolean {
  return panel.entries.length < 32;
}

/** Installed frozen documents are the panel catalogue; receipts and directories are not panels. */
export async function discoverPanelIds(directory: string): Promise<string[]> {
  const files = await readdir(directory, { withFileTypes: true });
  return files.flatMap((file) => {
    if (!file.isFile() || !file.name.endsWith('.panel.json')) return [];
    const id = file.name.slice(0, -'.panel.json'.length);
    return panelIdPattern.test(id) ? [id] : [];
  }).sort();
}

/** Verify exact frozen bytes, admitted split linkage, concrete input and explicit RNG seeds. */
export async function loadPanel(file: string): Promise<LoadedPanel> {
  file = path.resolve(file);
  const panel = PanelSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (path.basename(file).endsWith('.panel.json') && path.basename(file) !== `${panel.panelId}.panel.json`) throw new Error('panel filename and declared identity disagree');
  if (panel.digest !== panelDigest(panel)) throw new Error('panel digest mismatch');
  const expected = panel.expectedEpisodes ?? panel.entries.length;
  if (panel.entries.length !== expected || expected % 2 !== 0 || new Set(panel.entries.map((e) => e.id)).size !== expected) throw new Error('panel count/identity mismatch');
  const inputs = new Map<string, unknown>();
  const graphDigests = new Map<string, string>();
  const sourceSplits = new Map<string, ScenarioSplit>();
  for (const source of panel.sources) {
    const manifestBytes = await readFile(path.resolve(path.dirname(file), source.manifest));
    const episodeBytes = await readFile(path.resolve(path.dirname(file), source.episodes));
    if (createHash('sha256').update(manifestBytes).digest('hex') !== source.manifestSha256 || createHash('sha256').update(episodeBytes).digest('hex') !== source.episodesSha256) throw new Error(`panel ${source.purpose} source bytes changed`);
    const split = parseScenarioSplit(JSON.parse(manifestBytes.toString()));
    sourceSplits.set(source.purpose, split);
    if (split.purpose !== source.purpose || split.digest !== source.splitDigest || split.materialization.episodes.sha256 !== source.episodesSha256) throw new Error('panel split identity mismatch');
    const episodes = JSON.parse(episodeBytes.toString()) as { instances: { input: { mapId: string; clipSeconds: number }; provenance: { seed: number; cell: number; site: string; inputSha256: string; parentInputSha256?: string; replayKey: { engineGraphDigest: string } } }[] };
    for (const entry of panel.entries.filter((e) => e.source === source.purpose)) {
      const instance = episodes.instances[entry.instance];
      if (!instance || instance.provenance.seed !== entry.seed || instance.input.mapId !== entry.mapId || instance.provenance.site !== entry.site || instance.provenance.inputSha256 !== entry.inputSha256 || instance.input.clipSeconds !== entry.durationS) throw new Error(`panel entry identity mismatch: ${entry.id}`);
      if (createHash('sha256').update(canonicalJson(instance.input)).digest('hex') !== entry.inputSha256) throw new Error(`panel concrete digest mismatch: ${entry.id}`);
      if (!split.admission.proofs.some((p) => p.cell === instance.provenance.cell && p.status === 'admitted')) throw new Error(`unadmitted panel entry: ${entry.id}`);
      const proof = split.admission.proofs.find((p) => p.cell === instance.provenance.cell)!;
      const receipt = await readFile(path.resolve(path.dirname(file), path.dirname(source.manifest), proof.receipt.path));
      if (createHash('sha256').update(receipt).digest('hex') !== proof.receipt.sha256) throw new Error('panel admission receipt digest mismatch');
      graphDigests.set(entry.id, instance.provenance.replayKey.engineGraphDigest);
      inputs.set(entry.id, instance.input);
    }
  }
  if (sourceSplits.get('control')?.pairedWith?.digest !== sourceSplits.get('test')?.digest) throw new Error('panel control does not intervene on frozen test');
  for (const entry of panel.entries) {
    const pairs = panel.entries.filter((other) => other.pairId === entry.pairId);
    if (pairs.length !== 2 || pairs[0]!.source === pairs[1]!.source || pairs.some((p) => p.seed !== entry.seed || p.site !== entry.site || p.mapId !== entry.mapId)) throw new Error('panel requires exact test/control pairs');
  }
  return { panel, inputs, graphDigests, file };
}
