import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { modelsRoot } from './paths';

export const POLICY_FAMILY = 'simforge-policy' as const;
export const PolicyCheckpointSchema = z.object({
  schema: z.literal('simforge.policy-checkpoint/v1'),
  family: z.literal(POLICY_FAMILY),
  revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  checkpoint: z.literal('checkpoint.pt'),
  obsPreset: z.string().min(1),
  actionHead: z.enum(['setpoint', 'control', 'trajectory']),
  trainer: z.object({ recipe: z.enum(['ppo-teacher', 'distill-student']), configDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
  provenance: z.object({ splits: z.record(z.unknown()), kernelVersion: z.string(), gitSha: z.string().nullable() }).passthrough(),
  promoted: z.boolean(),
  promotion: z.object({
    verdict: z.enum(['qualified', 'exploratory', 'insufficient-evidence']),
    receipt: z.object({ path: z.string().regex(/^promotions\/[a-f0-9]{64}\.json$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  }).optional(),
}).refine((entry) => entry.promoted === (entry.promotion?.verdict === 'qualified'), 'promoted flag must match a qualified promotion receipt');
export type PolicyCheckpoint = z.infer<typeof PolicyCheckpointSchema>;

export async function policyCheckpoints(): Promise<PolicyCheckpoint[]> {
  const root = path.join(modelsRoot(), POLICY_FAMILY);
  const entries: PolicyCheckpoint[] = [];
  const runs = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const run of runs.filter((item) => item.isDirectory() && !item.name.startsWith('.'))) {
    for (const revision of await readdir(path.join(root, run.name), { withFileTypes: true })) {
      if (!revision.isDirectory() || revision.name.startsWith('.')) continue;
      const directory = path.join(root, run.name, revision.name);
      const entry = PolicyCheckpointSchema.parse(JSON.parse(await readFile(path.join(directory, 'entry.json'), 'utf8')));
      if (entry.promotion) await verifyPromotionReceipt(directory, entry);
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.revision.localeCompare(b.revision));
}

/** Store refs are immutable and re-hashed on every load; explicit paths remain supported. */
export async function resolvePolicyCheckpoint(ref: string): Promise<{ checkpoint: string; entry: PolicyCheckpoint | null }> {
  if (path.isAbsolute(ref) || ref.startsWith('./') || ref.startsWith('../')) {
    const checkpoint = path.resolve(ref);
    await access(checkpoint);
    return { checkpoint, entry: null };
  }
  const revision = ref.replace(/^simforge-policy\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(revision)) throw new Error('torch ref must be <run>/<update>, simforge-policy/<run>/<update>, or an explicit checkpoint path');
  const directory = path.join(modelsRoot(), POLICY_FAMILY, revision);
  const entry = PolicyCheckpointSchema.parse(JSON.parse(await readFile(path.join(directory, 'entry.json'), 'utf8')));
  if (entry.revision !== revision) throw new Error(`policy entry revision mismatch: ${revision}`);
  const checkpoint = path.join(directory, entry.checkpoint);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(checkpoint)) digest.update(chunk);
  if (digest.digest('hex') !== entry.sha256) throw new Error(`policy checkpoint SHA-256 mismatch: ${checkpoint}`);
  if (entry.promotion) await verifyPromotionReceipt(directory, entry);
  return { checkpoint, entry };
}

async function verifyPromotionReceipt(directory: string, entry: PolicyCheckpoint): Promise<void> {
  const reference = entry.promotion!.receipt;
  const bytes = await readFile(path.join(directory, reference.path));
  if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('promotion receipt SHA-256 mismatch');
  const report = JSON.parse(bytes.toString()) as { schema?: string; policy?: string; verdict?: string; checkpoint?: { sha256?: string } };
  if (report.schema !== 'simforge.promotion/v1' || report.policy?.replace(/^torch:(?:simforge-policy\/)?/, '') !== entry.revision || report.verdict !== entry.promotion!.verdict || report.checkpoint?.sha256 !== entry.sha256) throw new Error('promotion receipt checkpoint/verdict identity mismatch');
}

/** Immutable checkpoint bytes; only the digest-linked qualification pointer is mutable. */
export async function recordPolicyPromotion(ref: string, promotionFile: string): Promise<PolicyCheckpoint> {
  const resolved = await resolvePolicyCheckpoint(ref);
  if (!resolved.entry) throw new Error('promotion requires a registered policy ref');
  const entry = resolved.entry;
  const bytes = await readFile(promotionFile);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const report = JSON.parse(bytes.toString()) as { verdict: string };
  const updated = PolicyCheckpointSchema.parse({ ...entry, promoted: report.verdict === 'qualified', promotion: { verdict: report.verdict, receipt: { path: `promotions/${sha256}.json`, sha256 } } });
  const directory = path.dirname(resolved.checkpoint);
  await mkdir(path.join(directory, 'promotions'), { recursive: true });
  await writeFile(path.join(directory, updated.promotion!.receipt.path), bytes);
  await verifyPromotionReceipt(directory, updated);
  const file = path.join(directory, 'entry.json');
  await writeFile(`${file}.partial`, `${JSON.stringify(updated, null, 2)}\n`);
  await rename(`${file}.partial`, file);
  return updated;
}
