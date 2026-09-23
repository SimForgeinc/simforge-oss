/**
 * Archive corpus, documents: every scenario document and revision content
 * saved by a past release still loads through the current parser, and
 * re-serializes to a document the parser accepts again. The trace half of
 * the corpus runs in Rust (`native/crates/simforge-core/tests/archive_corpus.rs`).
 * See `fixtures/archive-corpus/README.md`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../canonical-json.js';
import { parseTemplate, serializeTemplate, simContentHash } from '../index.js';

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/archive-corpus');

interface DocumentEntry {
  id: string;
  kind: 'document' | 'revision' | 'trace';
  release: string;
  path: string;
  storedSha256: string;
  expect: { documentSha256: string };
}

const corpus = JSON.parse(readFileSync(join(CORPUS, 'corpus.json'), 'utf8')) as { schema: string; entries: DocumentEntry[] };
const documents = corpus.entries.filter((entry) => entry.kind === 'document' || entry.kind === 'revision');

function read(entry: DocumentEntry): unknown {
  const bytes = readFileSync(join(CORPUS, entry.path));
  expect(createHash('sha256').update(bytes).digest('hex'), `${entry.id}: stored bytes changed`).toBe(entry.storedSha256);
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
  return JSON.parse(text);
}

describe('archive corpus documents', () => {
  it('has documents from more than one release', () => {
    expect(corpus.schema).toBe('simforge.archive-corpus/v1');
    expect(new Set(documents.map((entry) => entry.release)).size).toBeGreaterThan(1);
  });

  for (const entry of documents) {
    it(`${entry.id} (${entry.release}) still loads`, () => {
      const stored = read(entry);
      expect(createHash('sha256').update(canonicalJson(stored)).digest('hex')).toBe(entry.expect.documentSha256);
      const template = parseTemplate(stored);
      // Round trip: what the current Studio would save is itself loadable,
      // and the simulation-relevant content hash is computable (a request key).
      const again = parseTemplate(JSON.parse(serializeTemplate(template)));
      expect(simContentHash(again)).toMatch(/^[a-f0-9]{64}$/);
    });
  }
});
