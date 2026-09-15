#!/usr/bin/env node
// Materializes the two NASA sky plates the render service needs, from the
// digests `renderer/render-core/assets/sky/SOURCES.json` pins.
//
//   node scripts/native-runtime/prepare-sky.mjs [--tools-dir <dir>] [--python <interpreter>]
//
// The plates (`*.skytex`) are gitignored derivatives, and
// scripts/native-runtime/build-runner.mjs refuses to build without them
// (`--no-sky` would yield a runtime with no render service at all), so every
// build host — CI leg or developer machine — has to produce them first. This
// is that step, in one place instead of once per workflow:
//
//   * each pinned original is downloaded into `renderer/assets-src` only when
//     it is not already there with its declared sha256 and length, and the
//     download is abandoned the moment it exceeds the pinned length;
//   * `renderer/tools/prepare_sky_assets.py` converts them;
//   * every emitted product is verified against its canonical pin;
//   * SOURCES.json is restored byte for byte afterwards, because the
//     converter rewrites the pins beside the plates it emits and a build
//     verifies the canonical pins rather than authoring replacements.
//
// stdout: {schema:'simforge.sky-prepare/v1', products:[{product,sha256,bytes}], downloaded}.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { delimiter } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { childEnv } from './target-layout.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKY_DIR = path.join(REPO_ROOT, 'renderer/render-core/assets/sky');
const SOURCES = path.join(SKY_DIR, 'SOURCES.json');
const INPUTS = path.join(REPO_ROOT, 'renderer/assets-src');
const SCHEMA = 'simforge.sky-assets/v1';

function fail(reason) {
  process.stderr.write(`${JSON.stringify({ code: 'sky.prepare_failed', reason })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { toolsDir: undefined, python: process.platform === 'win32' ? 'python' : 'python3' };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${argv[i]} requires a value`);
    switch (argv[i]) {
      case '--tools-dir': options.toolsDir = path.resolve(value); break;
      case '--python': options.python = value; break;
      default: fail(`unknown argument ${argv[i]}`);
    }
    i += 1;
  }
  return options;
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function present(file, sha256, bytes) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size !== bytes) return false;
  return (await digest(file)) === sha256;
}

/** Downloads one pinned original, refusing bytes beyond its declared length. */
async function fetchSource(source) {
  const target = path.join(INPUTS, source.download);
  if (await present(target, source.download_sha256, source.download_bytes)) return false;
  await mkdir(INPUTS, { recursive: true });
  const temporary = `${target}.partial`;
  const response = await fetch(source.file_url);
  if (!response.ok || !response.body) fail(`${source.file_url} answered ${response.status}`);
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > source.download_bytes) fail(`${source.file_url} exceeds its pinned length of ${source.download_bytes} bytes`);
        yield chunk;
      }
    },
    createWriteStream(temporary, { mode: 0o644 }),
  );
  if (size !== source.download_bytes || (await digest(temporary)) !== source.download_sha256) {
    await rm(temporary, { force: true });
    fail(`${source.file_url} differs from the digest SOURCES.json pins`);
  }
  await rename(temporary, target);
  return true;
}

async function main(argv) {
  const options = parseArgs(argv);
  const pinned = await readFile(SOURCES);
  const manifest = JSON.parse(pinned.toString('utf8'));
  if (manifest.schema !== SCHEMA) fail(`${SOURCES}: unsupported schema ${manifest.schema}`);

  let downloaded = 0;
  for (const source of manifest.sources) {
    if (await fetchSource(source)) downloaded += 1;
  }

  const tool = path.join(REPO_ROOT, 'renderer/tools/prepare_sky_assets.py');
  const env = childEnv(process.env, options.toolsDir ? { PATH: `${options.toolsDir}${delimiter}${process.env.PATH ?? ''}` } : {});
  const converted = spawnSync(options.python, [tool], { cwd: path.join(REPO_ROOT, 'renderer'), stdio: ['ignore', 'inherit', 'inherit'], env });
  if (converted.error) fail(`${options.python} ${tool}: ${converted.error.message}`);
  if (converted.status !== 0) fail(`${options.python} ${tool} exited ${converted.status ?? `signal ${converted.signal}`}`);

  const products = [];
  for (const source of manifest.sources) {
    const product = path.join(SKY_DIR, source.product);
    if (!(await present(product, source.product_sha256, source.product_bytes))) {
      fail(`${product} differs from the canonical pin in SOURCES.json; the conversion did not reproduce the pinned plate`);
    }
    products.push({ product: source.product, sha256: source.product_sha256, bytes: source.product_bytes });
  }
  // The converter rewrites the pins beside what it emitted; a build verifies
  // the canonical pins instead of authoring replacements for them.
  await writeFile(SOURCES, pinned);
  return { schema: 'simforge.sky-prepare/v1', products, downloaded };
}

main(process.argv.slice(2))
  .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
  .catch((error) => fail(error instanceof Error ? error.message : String(error)));
