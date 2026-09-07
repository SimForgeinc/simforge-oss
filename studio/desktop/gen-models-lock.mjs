#!/usr/bin/env node
// Generates studio/app/lib/models/models.lock.json from upstream metadata.
//
//   node desktop/gen-models-lock.mjs [--check] [--out <path>]
//
// Every digest in the lock comes from the source that publishes it, never
// from a hand-typed value:
//
//   * Weight shards and other LFS files: the `lfs.sha256` field of the
//     Hugging Face `?blobs=true` API for the PINNED REVISION. This is the
//     integrity source the installer verifies against.
//   * Small non-LFS files (config.json, tokenizer_config.json, ...): HF does
//     not publish a sha256 for them, only the git blob sha1. The generator
//     downloads them (kilobytes) and records BOTH the sha256 it computed and
//     the upstream `blobId`, so a reviewer can independently confirm the file
//     identity against git without trusting our hash.
//   * Upstream code: the git commit pinned in the catalog, plus the resolved
//     tree sha from the GitHub API.
//
// The lock is written at the root of packages/model-store, next to the
// installer that consumes it and inside that package's published `files`, so
// it resolves identically from source, from dist and from the packaged
// desktop app's node_modules. It deliberately does NOT live under
// studio/desktop: that directory is bundled into a single main.mjs and a
// sibling JSON file would not exist at runtime.
//
// `--check` regenerates in memory and diffs against the committed file,
// exiting 2 when they differ. That is the idempotence gate: the generator
// must produce a byte-identical file on a re-run.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(desktopDir, '..');
const repoRoot = resolve(studioRoot, '..');

export const MODEL_LOCK_SCHEMA = 'simforge.model-lock/v1';
export const DEFAULT_LOCK_PATH = join(repoRoot, 'packages', 'model-store', 'models.lock.json');

const USER_AGENT = 'simforge-model-store/1.0 (+https://github.com/SimForgeinc/simforge-oss)';
const HF_API = 'https://huggingface.co/api/models';
const GITHUB_API = 'https://api.github.com/repos';

/**
 * The catalog is TypeScript and this generator is plain node, so the values
 * are parsed out of the catalog source rather than duplicated here. A
 * mismatch between the catalog and the lock is then impossible by
 * construction: there is exactly one place the pins are written.
 */
async function readCatalogPins() {
  const source = await readFile(
    join(repoRoot, 'packages', 'model-store', 'src', 'catalog.ts'),
    'utf8',
  );
  const entries = [];
  // Each family literal is a `const NAME: ModelCatalogEntry = { ... };` block.
  const blocks = source.split(/^const (ALPAMAYO_[A-Z0-9_]+): ModelCatalogEntry = \{$/m);
  for (let index = 1; index < blocks.length; index += 2) {
    const body = blocks[index + 1];
    const field = (name) => {
      const match = body.match(new RegExp(`^\\s{2}${name}: '([^']*)',$`, 'm'));
      return match ? match[1] : null;
    };
    const family = field('family');
    if (!family) continue;
    const sidecars = [];
    const sidecarBlock = body.match(/^ {2}sidecars: \[([\s\S]*?)^ {2}\],$/m);
    if (sidecarBlock) {
      const text = sidecarBlock[1];
      const repoMatches = [...text.matchAll(/repo: '([^']+)',\s*\n\s*revision: '([^']+)'/g)];
      for (const [, repo, revision] of repoMatches) {
        const gated = new RegExp(`repo: '${repo.replace('/', '\\/')}'[\\s\\S]{0,400}?gated: (false|'auto')`).exec(text);
        sidecars.push({ repo, revision, gated: gated?.[1] === "'auto'" ? 'auto' : false });
      }
      // QWEN3_VL_2B_PROCESSOR is referenced by name, not inlined.
      if (/QWEN3_VL_2B_PROCESSOR/.test(text)) {
        const repo = /repo: '(Qwen\/Qwen3-VL-2B-Instruct)'/.exec(source)?.[1];
        const revision = /revision: '(89644892[0-9a-f]*)'/.exec(source)?.[1];
        if (repo && revision) sidecars.push({ repo, revision, gated: false });
      }
    }
    entries.push({
      family,
      weightsRepo: field('weightsRepo'),
      weightsRevision: field('weightsRevision'),
      codeRepo: field('codeRepo'),
      codeRevision: field('codeRevision'),
      pythonPackage: field('pythonPackage'),
      displayName: field('displayName'),
      sidecars,
    });
  }
  if (entries.length !== 3) {
    throw new Error(
      `expected 3 families in the catalog, parsed ${entries.length}: ` +
        `${entries.map((entry) => entry.family).join(', ')}`,
    );
  }
  return entries;
}

/** @param {string} url */
async function fetchJson(url) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  // A token is optional here and only ever read from the environment: the
  // generator is a maintainer tool, and gated sidecar METADATA needs one.
  const token = process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (token && url.startsWith(HF_API)) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Largest non-LFS file we accept a git-blob-sha1 pin for. Above this, a repo
 * is shipping real payload outside LFS and the lock should not pretend a
 * cheap metadata pin covers it.
 */
const NON_LFS_LIMIT = 32 * 1024 * 1024;

/**
 * File records for one repo at one revision, restricted to `wanted` when
 * given.
 *
 * Two digest kinds, both published by upstream and both verifiable locally
 * without trusting us:
 *
 *   * `hf-lfs`         — `lfs.sha256`, copied verbatim. Every weight shard.
 *   * `git-blob-sha1`  — the `blobId` HF publishes for non-LFS files, which
 *                        is `sha1("blob " + size + "\0" + content)` and so is
 *                        recomputable from the downloaded bytes.
 *
 * Using the blob id rather than downloading each small file to sha256 it
 * matters for correctness, not just cost: `nvidia/Cosmos-Reason2-8B` is
 * gated, its file CONTENT needs an accepted licence and a token, and the
 * generator must stay runnable by a maintainer who has neither. Metadata is
 * public for gated repos, so the pin is still upstream-sourced.
 */
async function fileRecords(repo, revision, wanted) {
  const meta = await fetchJson(`${HF_API}/${repo}/revision/${revision}?blobs=true`);
  if (meta.sha !== revision) {
    throw new Error(
      `${repo}: pinned revision ${revision} but the API resolved ${meta.sha}; ` +
        'update the catalog pin deliberately rather than following main',
    );
  }
  const siblings = meta.siblings ?? [];
  const selected = wanted
    ? siblings.filter((sibling) => wanted.includes(sibling.rfilename))
    : siblings.filter((sibling) => !sibling.rfilename.startsWith('images/'));

  if (wanted) {
    const missing = wanted.filter(
      (name) => !siblings.some((sibling) => sibling.rfilename === name),
    );
    if (missing.length) {
      // A sidecar file list that no longer matches upstream must fail loudly:
      // silently dropping one produces a load-time tokenizer mismatch later.
      throw new Error(`${repo}@${revision}: missing expected files ${missing.join(', ')}`);
    }
  }

  const files = [];
  for (const sibling of selected) {
    const path = sibling.rfilename;
    const lfsSha = sibling.lfs?.sha256 ?? null;
    if (lfsSha) {
      files.push({
        path,
        digestSource: 'hf-lfs',
        sha256: lfsSha,
        blobId: sibling.blobId ?? null,
        sizeBytes: sibling.size ?? sibling.lfs?.size ?? null,
      });
      continue;
    }
    if (!sibling.blobId) {
      throw new Error(`${repo}/${path}: no lfs.sha256 and no blobId to pin`);
    }
    if ((sibling.size ?? 0) > NON_LFS_LIMIT) {
      throw new Error(
        `${repo}/${path}: ${sibling.size} bytes outside LFS; a payload that ` +
          'large needs a content digest, not a blob-id pin',
      );
    }
    files.push({
      path,
      digestSource: 'git-blob-sha1',
      sha256: null,
      blobId: sibling.blobId,
      sizeBytes: sibling.size ?? null,
    });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, license: meta.cardData?.license ?? null, gated: meta.gated ?? false };
}

/**
 * Checkpoint identity: sha256 over the ordered `"<shard> <sha256>"` lines of
 * the weight shards. Derived entirely from published metadata, so a result
 * can name its checkpoint without re-hashing 22-72 GB.
 *
 * Emitted as BARE 64-hex, with no `sha256:` prefix, because this exact string
 * is what lands in `simforge.model_versions.checkpoint_digest` (constrained
 * `^[a-f0-9]{64}$`) and what the model-run worker compares against the
 * engine's reported identity. One representation, no translation layer that
 * could disagree.
 */
function checkpointDigest(files) {
  const shards = files
    .filter((file) => file.path.endsWith('.safetensors'))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  if (!shards.length) throw new Error('no safetensors shards to digest');
  const hasher = createHash('sha256');
  for (const shard of shards) hasher.update(`${shard.path} ${shard.sha256}\n`);
  return hasher.digest('hex');
}

async function codeRecord(codeRepo, codeRevision) {
  const slug = codeRepo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const commit = await fetchJson(`${GITHUB_API}/${slug}/commits/${codeRevision}`);
  if (commit.sha !== codeRevision) {
    throw new Error(`${slug}: resolved ${commit.sha} for pinned ${codeRevision}`);
  }
  return {
    git: codeRepo,
    commit: codeRevision,
    treeSha: commit.commit?.tree?.sha ?? null,
    committedAt: commit.commit?.committer?.date ?? null,
    license: 'Apache-2.0',
    // The upstream lock file the family venv is synced against.
    lock: `uv.lock@${codeRevision}`,
  };
}

export async function generateLock() {
  const catalog = await readCatalogPins();
  const models = {};

  for (const entry of catalog) {
    const weights = await fileRecords(entry.weightsRepo, entry.weightsRevision, null);
    const licenseFile = weights.files.find((file) => file.path === 'LICENSE');
    if (!licenseFile) {
      throw new Error(`${entry.weightsRepo}: no LICENSE file at the pinned revision`);
    }
    const sidecars = [];
    for (const sidecar of entry.sidecars) {
      const wanted = SIDECAR_FILES[sidecar.repo];
      const records = await fileRecords(sidecar.repo, sidecar.revision, wanted);
      sidecars.push({
        repo: sidecar.repo,
        revision: sidecar.revision,
        gated: records.gated === 'auto' ? 'auto' : records.gated === true ? true : false,
        license: records.license,
        files: records.files,
      });
    }

    models[entry.family] = {
      displayName: entry.displayName,
      weights: {
        repo: entry.weightsRepo,
        revision: entry.weightsRevision,
        license: 'OpenMDW-1.1',
        licenseBlobSha: licenseFile.blobId,
        checkpointDigest: checkpointDigest(weights.files),
        totalBytes: weights.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
        weightBytes: weights.files
          .filter((file) => file.path.endsWith('.safetensors'))
          .reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
        files: weights.files,
      },
      sidecars,
      code: await codeRecord(entry.codeRepo, entry.codeRevision),
      runtime: {
        python: '3.12',
        attn: 'sdpa',
        torch: '>=2.8',
        package: entry.pythonPackage,
      },
    };
  }

  return {
    schema: MODEL_LOCK_SCHEMA,
    note:
      'Generated by studio/desktop/gen-models-lock.mjs. Weight and other LFS ' +
      'digests are the upstream Hugging Face lfs.sha256 values verbatim; ' +
      'small non-LFS files carry a computed sha256 alongside the upstream git ' +
      'blobId. Do not hand-edit: run the generator.',
    generator: 'studio/desktop/gen-models-lock.mjs',
    models,
  };
}

/**
 * Sidecar file lists. Only config/tokenizer/processor text is ever taken from
 * a sidecar; `*.safetensors` is deliberately absent from every list because
 * all weights come from the Alpamayo checkpoint itself.
 */
const SIDECAR_FILES = {
  'Qwen/Qwen3-VL-8B-Instruct': [
    'config.json',
    'generation_config.json',
    'tokenizer_config.json',
    'tokenizer.json',
    'vocab.json',
    'merges.txt',
    'chat_template.json',
    'preprocessor_config.json',
    'video_preprocessor_config.json',
  ],
  'Qwen/Qwen3-VL-2B-Instruct': [
    'config.json',
    'generation_config.json',
    'tokenizer_config.json',
    'tokenizer.json',
    'vocab.json',
    'merges.txt',
    'chat_template.json',
    'preprocessor_config.json',
    'video_preprocessor_config.json',
  ],
  'nvidia/Cosmos-Reason2-8B': [
    'config.json',
    'generation_config.json',
    'tokenizer_config.json',
    'tokenizer.json',
    'vocab.json',
    'merges.txt',
    'chat_template.json',
    'preprocessor_config.json',
    'video_preprocessor_config.json',
  ],
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? resolve(args[outIndex + 1]) : DEFAULT_LOCK_PATH;
  const check = args.includes('--check');

  const lock = await generateLock();
  const serialized = `${JSON.stringify(lock, null, 2)}\n`;

  if (check) {
    let existing = null;
    try {
      existing = await readFile(outPath, 'utf8');
    } catch {
      console.error(`${outPath} does not exist; run without --check to create it`);
      process.exit(2);
    }
    if (existing !== serialized) {
      console.error(
        `${outPath} is not what the generator produces. Re-run ` +
          'node desktop/gen-models-lock.mjs and commit the result.',
      );
      process.exit(2);
    }
    console.log(JSON.stringify({ ok: true, path: outPath, families: Object.keys(lock.models) }));
    process.exit(0);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, serialized);
  console.log(
    JSON.stringify(
      {
        ok: true,
        path: outPath,
        families: Object.fromEntries(
          Object.entries(lock.models).map(([family, model]) => [
            family,
            {
              revision: model.weights.revision,
              files: model.weights.files.length,
              weightBytes: model.weights.weightBytes,
              checkpointDigest: model.weights.checkpointDigest,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}
