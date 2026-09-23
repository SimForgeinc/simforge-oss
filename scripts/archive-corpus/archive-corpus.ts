/**
 * Archive corpus maintenance: `fixtures/archive-corpus/` holds real artifacts
 * from past releases (stored bytes, verbatim) with the expectations every
 * later release must keep: they load, upgrade, keep their identity and
 * replay the same motion. See `fixtures/archive-corpus/README.md`.
 *
 *   pnpm archive-corpus add-trace <file> --id <id> --release <tag> --recorded <YYYY-MM-DD>
 *        --source <text> [--recorded-trace-sha256 <sha>] [--timeline <file>] [--note <text>]
 *   pnpm archive-corpus add-document <file> --id <id> --release <tag> --recorded <YYYY-MM-DD>
 *        --source <text> [--kind document|revision] [--note <text>]
 *   pnpm archive-corpus verify
 *
 * Expectations are computed here from the stored bytes alone (no SimForge
 * reader is involved), so the Rust and TypeScript tests check the readers
 * against an independent reference: the motion digest is the stored track
 * quantised to the trace grid, not whatever the current reader produces.
 * Entries are append-only: `add-*` refuses an existing id.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { canonicalJson } from '../../packages/scenario/src/canonical-json.js';
import { motionOf, timelineMotionOf } from './motion.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = join(ROOT, 'fixtures/archive-corpus');
const INDEX = join(CORPUS, 'corpus.json');
export const ARCHIVE_CORPUS_SCHEMA = 'simforge.archive-corpus/v1';

interface Corpus {
  schema: string;
  entries: Entry[];
}

interface EntryBase {
  id: string;
  release: string;
  recorded: string;
  source: string;
  path: string;
  storedSha256: string;
  note?: string;
}

interface TraceEntry extends EntryBase {
  kind: 'trace';
  expect: {
    shape: 'v1' | 'v3' | 'v4-pre-ledger' | 'v4';
    traceVersion: number;
    engineVersion: string;
    mapId: string;
    engineGraphDigest: string;
    actors: number;
    ticks: number;
    dt: number;
    unrecorded: string[];
    /** sha256(canonicalJson(stored document)). */
    documentSha256: string;
    /** The identity readers must report: the recorded traceSha256, else documentSha256 for upgraded traces; null when not pinned. */
    identity: string | null;
    recordedTraceSha256: string | null;
    motionSha256: string;
  };
  timeline?: { path: string; storedSha256: string; samplerVersion: string; timelineKey: string; heightFieldDigest: string; motionSha256: string };
}

interface DocumentEntry extends EntryBase {
  kind: 'document' | 'revision';
  expect: { scenarioVersion: number | null; documentSha256: string };
}

type Entry = TraceEntry | DocumentEntry;

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const plain = (bytes: Uint8Array) => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes));

function shapeOf(doc: Record<string, any>): TraceEntry['expect']['shape'] {
  const v = doc.header?.traceVersion;
  if (v === 1) return 'v1';
  if (v === 3) return 'v3';
  if (v === 4) return doc.header.ego && doc.semanticLedger ? 'v4' : 'v4-pre-ledger';
  throw new Error(`unknown traceVersion ${String(v)}: add its shape here and its upgrade step in native/crates/simforge-core/src/trace/upgrade.rs`);
}

/** What each released shape never recorded (mirrors the table in upgrade.rs, derived from the document here). */
function unrecordedOf(doc: Record<string, any>, shape: TraceEntry['expect']['shape']): string[] {
  const out = new Set<string>();
  const tracks = Object.values(doc.ticks.actors) as Record<string, unknown>[];
  if (!doc.header.physics) out.add('header.physics.resolvedProfileDigest').add('header.physics.crashes');
  if (!doc.metrics?.criticalitySamples) out.add('metrics.criticalitySamples');
  if (tracks.some((t) => !('lateralOffsetM' in t))) out.add('ticks.actors.*.lateralOffsetM');
  if (shape !== 'v4') {
    if (!doc.header.ego) out.add('header.ego');
    if (!doc.semanticLedger) out.add('semanticLedger');
  }
  return [...out].sort();
}

function load(): Corpus {
  return existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) as Corpus : { schema: ARCHIVE_CORPUS_SCHEMA, entries: [] };
}

function save(corpus: Corpus) {
  corpus.entries.sort((a, b) => (a.kind === b.kind ? (a.recorded === b.recorded ? (a.id < b.id ? -1 : 1) : a.recorded < b.recorded ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  writeFileSync(INDEX, `${JSON.stringify(corpus, null, 2)}\n`);
}

function args(argv: string[]) {
  const out: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i] ?? '';
    else positional.push(a);
  }
  return { flags: out, positional };
}

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

function place(file: string, dir: string, name: string): { path: string; bytes: Buffer } {
  const bytes = readFileSync(file);
  mkdirSync(join(CORPUS, dir), { recursive: true });
  const target = join(CORPUS, dir, name);
  if (existsSync(target)) throw new Error(`${relative(ROOT, target)} already exists (the corpus is append-only)`);
  copyFileSync(file, target);
  return { path: relative(CORPUS, target), bytes };
}

function addTrace(file: string, flags: Record<string, string>) {
  const corpus = load();
  const id = required(flags, 'id');
  if (corpus.entries.some((e) => e.id === id)) throw new Error(`entry ${id} already exists (the corpus is append-only)`);
  const gz = file.endsWith('.gz');
  const { path, bytes } = place(file, 'traces', `${id}.trace.json${gz ? '.gz' : ''}`);
  const doc = JSON.parse(plain(bytes).toString('utf8')) as Record<string, any>;
  const shape = shapeOf(doc);
  const documentSha256 = sha256(canonicalJson(doc));
  const recorded = flags['recorded-trace-sha256'] || null;
  const entry: TraceEntry = {
    id,
    kind: 'trace',
    release: required(flags, 'release'),
    recorded: required(flags, 'recorded'),
    source: required(flags, 'source'),
    path,
    storedSha256: sha256(bytes),
    ...(flags.note ? { note: flags.note } : {}),
    expect: {
      shape,
      traceVersion: doc.header.traceVersion,
      engineVersion: doc.header.engineVersion,
      mapId: doc.header.mapId,
      engineGraphDigest: doc.header.engineGraphDigest,
      actors: Object.keys(doc.ticks.actors).length,
      ticks: doc.ticks.t.length,
      dt: doc.header.dt,
      unrecorded: unrecordedOf(doc, shape),
      documentSha256,
      identity: recorded ?? (shape === 'v4' ? null : documentSha256),
      recordedTraceSha256: recorded,
      motionSha256: sha256(canonicalJson(motionOf(doc as never))),
    },
  };
  if (flags.timeline) {
    const placed = place(flags.timeline, 'timelines', `${id}.timeline.json${flags.timeline.endsWith('.gz') ? '.gz' : ''}`);
    const tl = JSON.parse(plain(placed.bytes).toString('utf8'));
    entry.timeline = {
      path: placed.path,
      storedSha256: sha256(placed.bytes),
      samplerVersion: tl.identity.samplerVersion,
      timelineKey: tl.identity.timelineKey,
      heightFieldDigest: tl.identity.heightFieldDigest,
      motionSha256: sha256(canonicalJson(timelineMotionOf(tl))),
    };
    if (tl.identity.traceSha256 !== (recorded ?? tl.identity.traceSha256)) {
      throw new Error(`timeline ${flags.timeline} was derived from trace ${tl.identity.traceSha256}, not ${recorded}`);
    }
  }
  corpus.entries.push(entry);
  save(corpus);
  console.log(`added trace ${id}: ${shape}, ${entry.expect.actors} actors × ${entry.expect.ticks} ticks, unrecorded [${entry.expect.unrecorded.join(', ')}]`);
}

function addDocument(file: string, flags: Record<string, string>) {
  const corpus = load();
  const id = required(flags, 'id');
  if (corpus.entries.some((e) => e.id === id)) throw new Error(`entry ${id} already exists (the corpus is append-only)`);
  const kind = (flags.kind ?? 'document') as DocumentEntry['kind'];
  const { path, bytes } = place(file, 'documents', `${id}.json`);
  const doc = JSON.parse(plain(bytes).toString('utf8')) as Record<string, any>;
  corpus.entries.push({
    id,
    kind,
    release: required(flags, 'release'),
    recorded: required(flags, 'recorded'),
    source: required(flags, 'source'),
    path,
    storedSha256: sha256(bytes),
    ...(flags.note ? { note: flags.note } : {}),
    expect: { scenarioVersion: typeof doc.scenarioVersion === 'number' ? doc.scenarioVersion : null, documentSha256: sha256(canonicalJson(doc)) },
  });
  save(corpus);
  console.log(`added ${kind} ${id}`);
}

function verify() {
  const corpus = load();
  if (corpus.schema !== ARCHIVE_CORPUS_SCHEMA) throw new Error(`corpus schema ${corpus.schema}`);
  let failures = 0;
  for (const entry of corpus.entries) {
    const bytes = readFileSync(join(CORPUS, entry.path));
    const problems: string[] = [];
    if (sha256(bytes) !== entry.storedSha256) problems.push('stored bytes changed');
    const doc = JSON.parse(plain(bytes).toString('utf8'));
    if (sha256(canonicalJson(doc)) !== entry.expect.documentSha256) problems.push('document digest changed');
    if (entry.kind === 'trace' && sha256(canonicalJson(motionOf(doc))) !== entry.expect.motionSha256) problems.push('motion digest changed');
    if (entry.kind === 'trace' && entry.timeline && sha256(readFileSync(join(CORPUS, entry.timeline.path))) !== entry.timeline.storedSha256) problems.push('stored timeline changed');
    if (problems.length) {
      failures++;
      console.error(`${entry.id}: ${problems.join('; ')}`);
    }
  }
  console.log(`${corpus.entries.length - failures}/${corpus.entries.length} archive entries intact`);
  if (failures) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = args(rest);
if (command === 'add-trace') addTrace(required({ file: positional[0] ?? '' }, 'file'), flags);
else if (command === 'add-document') addDocument(required({ file: positional[0] ?? '' }, 'file'), flags);
else if (command === 'verify') verify();
else {
  console.error('usage: archive-corpus add-trace|add-document <file> --id … | verify');
  process.exit(2);
}
