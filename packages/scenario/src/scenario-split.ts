import { z } from 'zod-v4';
import { canonicalize } from './serialize.js';
import { Sha256 } from './sha256.js';

export const SCENARIO_SPLIT_SCHEMA = 'simforge.scenario-split/v1' as const;
const token = z.string().min(1).max(512);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const seed = z.number().int().nonnegative().max(0xffffffff);
export const SplitArtifactSchema = z.strictObject({ path: token, sha256: digest });
export const SplitSeedsSchema = z.union([
  z.strictObject({ from: seed, to: seed }).refine((value) => value.to >= value.from && value.to - value.from < 100_000, 'seed range must be ascending and bounded to 100,000 draws'),
  z.array(seed).min(1).max(100_000).refine((values) => new Set(values).size === values.length, 'duplicate seeds'),
]);
export const ScenarioSplitCellSchema = z.strictObject({
  template: token,
  map: token,
  site: token,
  seeds: SplitSeedsSchema,
  /** First draw index; successive seeds increment it. Omitted: drawIndex = seed. Never -1. */
  drawIndex: seed.optional(),
});
export const ScenarioSplitProofSchema = z.strictObject({
  cell: z.number().int().nonnegative(),
  checks: z.union([
    z.tuple([z.literal('geometry'), z.literal('occlusion'), z.literal('solvability')]),
    z.tuple([z.literal('geometry'), z.literal('occlusion'), z.literal('solvability'), z.literal('bench-window')]),
  ]),
  status: z.enum(['admitted', 'excluded']),
  reason: token.optional(),
  /** Template-independent map-intel origin, preventing different family IDs hiding site leakage. */
  siteKey: token.optional(),
  receipt: SplitArtifactSchema,
}).superRefine((value, ctx) => {
  if (value.status === 'excluded' && !value.reason) ctx.addIssue({ code: 'custom', message: 'excluded cell needs a reason' });
  if (value.status === 'admitted' && !value.siteKey) ctx.addIssue({ code: 'custom', message: 'admitted cell needs its map-intel site key' });
});
const requestShape = {
  schema: z.literal(SCENARIO_SPLIT_SCHEMA),
  splitId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  purpose: z.enum(['train', 'val', 'test', 'control']),
  cells: z.array(ScenarioSplitCellSchema).max(10_000),
  /** Controls are not an independent split: their exact parent and intervention are verified. */
  pairedWith: z.strictObject({ splitId: token, digest, manifest: token, intervention: z.literal('remove-hazards') }).optional(),
};
export const ScenarioSplitRequestSchema = z.strictObject(requestShape);
export const ScenarioSplitSchema = z.strictObject({
  ...requestShape,
  admission: z.strictObject({
    proofs: z.array(ScenarioSplitProofSchema),
    generatedAt: z.iso.datetime(),
    compilerVersion: token,
    nativeAddonSha256: digest,
  }),
  materialization: z.strictObject({
    episodes: SplitArtifactSchema,
    count: z.number().int().nonnegative(),
  }),
  digest,
}).superRefine((value, ctx) => {
  if ((value.purpose === 'control') !== Boolean(value.pairedWith)) ctx.addIssue({ code: 'custom', message: 'only control splits must declare pairedWith' });
  const indexes = new Set<number>();
  let count = 0;
  for (const proof of value.admission.proofs) {
    const cell = value.cells[proof.cell];
    if (!cell || indexes.has(proof.cell)) ctx.addIssue({ code: 'custom', message: `invalid or repeated proof cell ${proof.cell}` });
    indexes.add(proof.cell);
    if (cell && proof.status === 'admitted') count += splitSeeds(cell).length;
  }
  if (indexes.size !== value.cells.length) ctx.addIssue({ code: 'custom', message: 'every requested cell needs an admission proof, including excluded cells' });
  if (count !== value.materialization.count) ctx.addIssue({ code: 'custom', message: 'materialized count differs from admitted seed count' });
  for (const cell of value.cells) {
    if (cell.drawIndex !== undefined && cell.drawIndex + splitSeeds(cell).length - 1 > 0xffffffff) ctx.addIssue({ code: 'custom', message: 'drawIndex range overflows' });
  }
});

export type ScenarioSplitCell = z.infer<typeof ScenarioSplitCellSchema>;
export type ScenarioSplitRequest = z.infer<typeof ScenarioSplitRequestSchema>;
export type ScenarioSplit = z.infer<typeof ScenarioSplitSchema>;
export type ScenarioSplitProof = z.infer<typeof ScenarioSplitProofSchema>;
export type SplitArtifact = z.infer<typeof SplitArtifactSchema>;

export function splitSeeds(cell: ScenarioSplitCell): number[] {
  const seeds = cell.seeds;
  return Array.isArray(seeds) ? seeds : Array.from({ length: seeds.to - seeds.from + 1 }, (_, i) => seeds.from + i);
}

export function splitDrawIndex(cell: ScenarioSplitCell, seedValue: number, ordinal: number): number {
  return cell.drawIndex === undefined ? seedValue : cell.drawIndex + ordinal;
}

/** Same portable canonicalization/hash convention as situation programs. Artifact bytes have their own exact SHA256. */
export function scenarioSplitDigest(value: Omit<ScenarioSplit, 'digest'> | ScenarioSplit): string {
  const { digest: _digest, ...document } = value as ScenarioSplit;
  return new Sha256().update(new TextEncoder().encode(JSON.stringify(canonicalize(document)))).digestHex();
}

export function parseScenarioSplit(value: unknown): ScenarioSplit {
  const split = ScenarioSplitSchema.parse(value);
  if (scenarioSplitDigest(split) !== split.digest) throw new Error(`split digest mismatch: ${split.splitId}`);
  return split;
}

/** San Ramon releases are one geography, not held-out maps. */
export function splitGeography(map: string): string {
  return /^san-ramon(?:-|$)/.test(map) ? 'san-ramon' : map;
}

/** Pure independence checks. The CLI additionally validates every paired control's exact input transformation. */
export function verifyScenarioSplits(values: readonly unknown[]): ScenarioSplit[] {
  const splits = values.map(parseScenarioSplit);
  if (new Set(splits.map((split) => split.splitId)).size !== splits.length) throw new Error('duplicate splitId');
  for (const split of splits) {
    if (!split.pairedWith) continue;
    const parent = splits.find((candidate) => candidate.splitId === split.pairedWith!.splitId);
    if (!parent || parent.purpose !== 'test' || parent.digest !== split.pairedWith.digest) throw new Error(`${split.splitId}: paired test split missing or digest mismatch`);
  }
  const admitted = (split: ScenarioSplit) => split.admission.proofs.filter((proof) => proof.status === 'admitted');
  for (let i = 0; i < splits.length; i++) for (let j = i + 1; j < splits.length; j++) {
    const a = splits[i]!; const b = splits[j]!;
    if (a.pairedWith?.splitId === b.splitId || b.pairedWith?.splitId === a.splitId) continue;
    const seeds = new Set(admitted(a).flatMap((proof) => splitSeeds(a.cells[proof.cell]!)));
    const sites = new Set(admitted(a).map((proof) => proof.siteKey));
    const maps = new Set(admitted(a).map((proof) => splitGeography(a.cells[proof.cell]!.map)));
    for (const proof of admitted(b)) {
      const cell = b.cells[proof.cell]!;
      const overlap = splitSeeds(cell).find((value) => seeds.has(value));
      if (overlap !== undefined) throw new Error(`${a.splitId}/${b.splitId}: seed overlap ${overlap}`);
      if (sites.has(proof.siteKey)) throw new Error(`${a.splitId}/${b.splitId}: site overlap ${proof.siteKey}`);
      const holdout = (a.purpose === 'test' || a.purpose === 'control') !== (b.purpose === 'test' || b.purpose === 'control');
      if (holdout && maps.has(splitGeography(cell.map))) throw new Error(`${a.splitId}/${b.splitId}: held-out geography overlap ${splitGeography(cell.map)}`);
    }
  }
  return splits;
}
