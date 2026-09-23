/**
 * Retention references: what lives OUTSIDE the registry and still needs its bytes.
 *
 * The registry only knows its own closures. Scenario revisions, saved
 * simulation results and render jobs name map content by digest in a host's
 * database, and the registry cannot see those rows. Any operation that deletes
 * content-addressed objects therefore has to ask the host which digests are
 * still referenced, and it must not proceed when nobody can answer: "no answer"
 * is not "nothing is referenced".
 *
 * A host supplies a {@link RetentionReferenceSource}. The CLI builds one from
 * a `simforge.retention-refs.v1` document (a file or an http(s) URL) that the
 * host generates immediately before the prune.
 */

export const RETENTION_REFS_SCHEMA = 'simforge.retention-refs.v1';

/** Default freshness bound for a refs document: a stale snapshot misses revisions created since. */
export const RETENTION_REFS_MAX_AGE_MS = 60 * 60 * 1000;

const DIGEST = /^[a-f0-9]{64}$/;

/** The exchange format a host writes and `simforge maps prune --refs` reads. */
export interface RetentionRefsDocument {
  schema: typeof RETENTION_REFS_SCHEMA;
  /** ISO-8601 time the snapshot was taken. */
  generatedAt: string;
  /** Who produced it, for the audit trail (e.g. `studio:<host>`). Free text, never parsed. */
  source: string;
  /** Every sha256 the host still references: map members, xodr, closures, releases, traces. */
  digests: string[];
}

/** Answers "which of these digests is still referenced?" for a destructive operation. */
export interface RetentionReferenceSource {
  /** Human-readable origin, echoed in errors and prune reports. */
  readonly description: string;
  /**
   * The subset of `candidates` that something outside the registry references.
   * Implementations must throw when they cannot answer; returning an empty set
   * means "verified: none of these is referenced".
   */
  referenced(candidates: readonly string[]): Promise<ReadonlySet<string>>;
}

/** Thrown when a destructive operation has no reference source to consult. */
export class RetentionRefsRequiredError extends Error {
  readonly code = 'retention_refs_required';
  constructor(operation: string) {
    super(
      `${operation} deletes content-addressed objects, and the registry cannot see what scenario revisions, ` +
      'saved simulation results or render jobs still reference. Refusing to run without a retention reference ' +
      `source. Generate a ${RETENTION_REFS_SCHEMA} document from the installation that owns those records ` +
      '(it lists every sha256 they reference) right before pruning and pass it with --refs <file|https-url>. ' +
      'Nothing was deleted.',
    );
    this.name = 'RetentionRefsRequiredError';
  }

  /** Structured-error reason (the CLI maps `{code, reason}` errors to its JSON error shape). */
  get reason(): string {
    return this.message;
  }
}

/** Thrown when an explicitly selected object is still referenced. */
export class RetainedReferenceError extends Error {
  readonly code = 'retention_referenced';
  constructor(message: string, readonly referenced: readonly string[]) {
    super(message);
    this.name = 'RetainedReferenceError';
  }

  get reason(): string {
    return this.message;
  }
}

/** Strictly validate a refs document; any deviation is an error, never a partial read. */
export function parseRetentionRefs(value: unknown, label: string): RetentionRefsDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: retention refs must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  if (record['schema'] !== RETENTION_REFS_SCHEMA) {
    throw new Error(`${label}: retention refs schema must be ${RETENTION_REFS_SCHEMA}, got ${JSON.stringify(record['schema'])}`);
  }
  const generatedAt = record['generatedAt'];
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`${label}: retention refs need an ISO-8601 generatedAt`);
  }
  const source = record['source'];
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error(`${label}: retention refs need a non-empty source`);
  }
  const digests = record['digests'];
  if (!Array.isArray(digests)) throw new Error(`${label}: retention refs need a digests array`);
  digests.forEach((digest, index) => {
    if (typeof digest !== 'string' || !DIGEST.test(digest)) {
      throw new Error(`${label}: digests[${index}] is not a lowercase sha256 hex digest`);
    }
  });
  return { schema: RETENTION_REFS_SCHEMA, generatedAt, source, digests: digests as string[] };
}

export interface RetentionDocumentOptions {
  /** Reject snapshots older than this (default {@link RETENTION_REFS_MAX_AGE_MS}). */
  maxAgeMs?: number;
  now?: () => number;
}

/** A reference source backed by one validated, fresh snapshot. */
export function retentionSourceFromDocument(
  document: RetentionRefsDocument,
  label: string,
  options: RetentionDocumentOptions = {},
): RetentionReferenceSource {
  const maxAgeMs = options.maxAgeMs ?? RETENTION_REFS_MAX_AGE_MS;
  const now = (options.now ?? Date.now)();
  const age = now - Date.parse(document.generatedAt);
  if (age > maxAgeMs) {
    throw new Error(
      `${label}: retention refs generated at ${document.generatedAt} are older than ${Math.round(maxAgeMs / 60000)} min; ` +
      'records created since would not be protected. Regenerate them right before pruning.',
    );
  }
  if (age < -5 * 60 * 1000) {
    throw new Error(`${label}: retention refs generatedAt ${document.generatedAt} is in the future; check the producer's clock`);
  }
  const digests = new Set(document.digests);
  return {
    description: `${label} (${document.source}, ${document.generatedAt}, ${digests.size} digests)`,
    async referenced(candidates) {
      return new Set(candidates.filter((digest) => digests.has(digest)));
    },
  };
}

/** Union of several sources: a digest is referenced if any source says so; any failure fails the whole answer. */
export function combineRetentionSources(sources: readonly RetentionReferenceSource[]): RetentionReferenceSource {
  if (sources.length === 0) throw new Error('combineRetentionSources needs at least one source');
  if (sources.length === 1) return sources[0]!;
  return {
    description: sources.map((source) => source.description).join(' + '),
    async referenced(candidates) {
      const union = new Set<string>();
      for (const source of sources) for (const digest of await source.referenced(candidates)) union.add(digest);
      return union;
    },
  };
}
