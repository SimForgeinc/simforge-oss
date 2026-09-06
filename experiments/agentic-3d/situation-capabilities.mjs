import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, contentHash } from '@simforge-oss/engine';

const SCHEMA = 'simforge.situation-capability-memory/v1';
const RECORD_SCHEMA = 'simforge.situation-capability/v1';
const snapshots = new WeakSet();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const keys = (value, expected, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key)), `Invalid ${label} fields`);
};
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
const prose = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 600
  && !/[\x00-\x1f\x7f{}\[\]`<>]/.test(value)
  && !/(?:\$\(|=>|\b(?:program|brief|template|scenario|answer)\s*:)/i.test(value);

function referencePath(uri) {
  assert(typeof uri === 'string' && uri.startsWith('file:///'), 'Reference must be a local file URI');
  const url = new URL(uri);
  assert(url.protocol === 'file:' && !url.host && !url.search && !url.hash, 'Invalid local file URI');
  const file = fileURLToPath(url);
  assert(!/[\x00-\x1f\x7f]/.test(file) && pathToFileURL(file).href === uri, 'Noncanonical local file URI');
  return file;
}

function references(value, label) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 32, `${label} proof references are required (maximum 32)`);
  const seen = new Set();
  for (const ref of value) {
    keys(ref, ['uri', 'sha256'], label);
    referencePath(ref.uri);
    assert(typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256), `Invalid ${label} SHA256`);
    assert(!seen.has(ref.uri), `Duplicate ${label} URI`);
    seen.add(ref.uri);
  }
}

function validateRecords(records) {
  assert(Array.isArray(records) && records.length <= 1024, 'Capability records must be an array of at most 1024 entries');
  const ids = new Set(), claims = new Set(), hashes = new Map();
  for (const record of records) {
    keys(record, ['schema', 'id', 'backend', 'operation', 'support', 'scope', 'mechanism', 'implementation', 'evidence'], 'capability record');
    assert(record.schema === RECORD_SCHEMA, 'Unsupported capability record schema');
    for (const key of ['id', 'backend', 'operation']) assert(identifier(record[key]), `Invalid capability ${key}`);
    assert(['supported', 'partial', 'unsupported'].includes(record.support), 'Invalid capability support');
    assert(prose(record.scope) && prose(record.mechanism), 'Scope and mechanism must be short plain prose, not embedded program, brief or template payloads');
    assert(!ids.has(record.id), 'Duplicate capability ID');
    ids.add(record.id);
    const claim = canonicalJson([record.backend, record.operation, record.scope]);
    assert(!claims.has(claim), 'Duplicate capability claim');
    claims.add(claim);
    references(record.implementation, 'implementation');
    references(record.evidence, 'evidence');
    const sources = new Set(record.implementation.map(ref => ref.uri));
    for (const ref of record.evidence) assert(!sources.has(ref.uri), 'Evidence must be separate from implementation');
    for (const ref of [...record.implementation, ...record.evidence]) {
      assert(!hashes.has(ref.uri) || hashes.get(ref.uri) === ref.sha256, 'Conflicting reference fingerprints');
      hashes.set(ref.uri, ref.sha256);
    }
  }
}

function fingerprint(ref) {
  const file = referencePath(ref.uri);
  const fd = fs.openSync(file, 'r');
  try {
    assert(fs.fstatSync(fd).isFile(), `Reference is not a regular file: ${ref.uri}`);
    return sha(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}

function verifyEvidence(records) {
  const verified = new Set();
  for (const record of records) for (const ref of record.evidence) {
    if (verified.has(ref.uri)) continue;
    assert(fingerprint(ref) === ref.sha256, `Capability evidence SHA256 mismatch: ${ref.uri}`);
    verified.add(ref.uri);
  }
}

function staleFindings(record, fingerprints) {
  const findings = [];
  for (const ref of record.implementation) {
    if (!fingerprints.has(ref.uri)) {
      try { fingerprints.set(ref.uri, { actualSha256: fingerprint(ref), reason: 'implementation-changed' }); }
      catch { fingerprints.set(ref.uri, { actualSha256: null, reason: 'implementation-unavailable' }); }
    }
    const current = fingerprints.get(ref.uri);
    if (current.actualSha256 !== ref.sha256) findings.push({ uri: ref.uri, expectedSha256: ref.sha256, ...current });
  }
  return findings;
}

/** A digest-bound curated snapshot; evidence is checked again at every lookup. */
export function loadCapabilityMemory(file) {
  const memory = JSON.parse(fs.readFileSync(file, 'utf8'));
  keys(memory, ['schema', 'digest', 'records'], 'capability memory');
  assert(memory.schema === SCHEMA, 'Unsupported capability memory schema');
  validateRecords(memory.records);
  assert(typeof memory.digest === 'string' && /^[a-f0-9]{64}$/.test(memory.digest)
    && memory.digest === contentHash({ schema: memory.schema, records: memory.records }), 'Capability memory digest mismatch');
  verifyEvidence(memory.records);
  memory.records.sort((a, b) => compare(a.id, b.id));
  // Canonical order is part of the on-disk digest, not an implicit repair.
  assert(memory.digest === contentHash({ schema: memory.schema, records: memory.records }), 'Capability records are not canonically ordered');
  freeze(memory);
  snapshots.add(memory);
  return memory;
}

/** Explicit curation only. Never call this from an authoring tool or run-error path. */
export function writeCapabilityMemory(file, records) {
  validateRecords(records);
  const normalized = JSON.parse(canonicalJson(records));
  normalized.sort((a, b) => compare(a.id, b.id));
  verifyEvidence(normalized);
  const fingerprints = new Map();
  for (const record of normalized) assert(staleFindings(record, fingerprints).length === 0, `Cannot write stale capability: ${record.id}`);
  const target = path.resolve(file);
  const targetReal = fs.existsSync(target) ? fs.realpathSync(target) : target;
  for (const record of normalized) for (const ref of [...record.implementation, ...record.evidence]) {
    const source = referencePath(ref.uri);
    assert(source !== target && fs.realpathSync(source) !== targetReal, 'Memory output cannot overwrite a proof source');
  }
  const payload = { schema: SCHEMA, records: normalized };
  const memory = { schema: SCHEMA, digest: contentHash(payload), records: normalized };
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${canonicalJson(memory)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  freeze(memory);
  snapshots.add(memory);
  return memory;
}

/** Exact backend/operation filters and case-insensitive literal prose search; no scenario retrieval. */
export function queryCapabilityMemory(memory, options = {}) {
  assert(snapshots.has(memory), 'Capability memory must be a loaded or written immutable snapshot');
  assert(options && typeof options === 'object' && !Array.isArray(options)
    && Object.keys(options).every(key => ['backend', 'operation', 'search', 'limit'].includes(key)), 'Invalid capability query fields');
  const { backend, operation, search, limit = 10 } = options;
  for (const [key, value] of [['backend', backend], ['operation', operation]]) assert(value === undefined || identifier(value), `Invalid query ${key}`);
  assert(search === undefined || (typeof search === 'string' && search.length <= 200 && !/[\x00-\x1f\x7f]/.test(search)), 'Invalid capability search');
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Capability query limit must be 1..100');
  verifyEvidence(memory.records);
  const needle = search?.toLowerCase();
  const matching = memory.records.filter(record => (backend === undefined || record.backend === backend)
    && (operation === undefined || record.operation === operation)
    && (!needle || [record.id, record.backend, record.operation, record.scope, record.mechanism].some(value => value.toLowerCase().includes(needle))));
  const records = [], stale = [], fingerprints = new Map();
  for (const record of matching.slice(0, limit)) {
    const findings = staleFindings(record, fingerprints);
    if (findings.length) stale.push({ id: record.id, backend: record.backend, operation: record.operation, status: 'stale', findings });
    else records.push(record);
  }
  return freeze({ schema: SCHEMA, digest: memory.digest, records, stale, truncated: matching.length > limit });
}
