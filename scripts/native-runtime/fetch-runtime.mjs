#!/usr/bin/env node
// Materializes the pinned prebuilt runtime archive for one target, verified,
// into the runtime root's download cache:
//
//   ROOT/downloads/simforge-native-runtime-<version>-<triple>.tar.gz
//
// Same shape as packages/render/scripts/fetch-actor-closure.mjs: a pin in the
// repository (scripts/native-runtime/runtime-release.json), a digest and size
// checked after the bytes land, a cache that needs no network when it already
// holds the right bytes, and a refusal — never a warning — when they differ.
//
//   node scripts/native-runtime/fetch-runtime.mjs [--target <triple>]
//     [--root <dir>] [--base-url <origin>] [--abi <n>]
//
//   --root      runtime root (default $SIMFORGE_NATIVE_RUNTIME_ROOT or the OS
//               default; the cache is ROOT/downloads/)
//   --base-url  where the assets live (default the pinned GitHub release;
//               $SIMFORGE_NATIVE_RUNTIME_BASE_URL overrides for local mirrors)
//   --abi       ABI the caller requires (default: what this checkout's
//               `@simforge-oss/native-runtime` is typed against)
//
// The ABI is checked HERE, before install-runtime.mjs unpacks anything, so a
// runtime built against another binding ABI is refused instead of being
// installed and discovered at first render. Install then re-checks the
// archive's own manifest closure and the runner's reported revision.
//
// stdout: {schema:'simforge.native-runtime-fetch/v1', archive, target, url,
//          sha256, sizeBytes, version, revision, abi, cached, gpuInterop,
//          tested}. Exit 1 with {code, reason} on stderr.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { requiredAbi } from './abi.mjs';
import { defaultRuntimeRoot, tripleForNode } from './target-layout.mjs';

const PIN_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'runtime-release.json');
const SCHEMA = 'simforge.native-runtime-release/v1';

class FetchFailure extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

function fail(code, reason) {
  process.stderr.write(`${JSON.stringify({ code, reason })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { target: undefined, root: undefined, baseUrl: undefined, abi: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new FetchFailure('runtime.usage', `${flag} requires a value`);
    switch (flag) {
      case '--target': options.target = value; break;
      case '--root': options.root = path.resolve(value); break;
      case '--base-url': options.baseUrl = value; break;
      case '--abi': options.abi = Number.parseInt(value, 10); break;
      default: throw new FetchFailure('runtime.usage', `unknown argument ${flag}`);
    }
    i += 1;
  }
  return options;
}

export async function readReleasePin(file = PIN_FILE) {
  const pin = JSON.parse(await readFile(file, 'utf8'));
  if (pin.schema !== SCHEMA) throw new FetchFailure('runtime.pin_invalid', `${file}: schema is not ${SCHEMA}`);
  return pin;
}

async function digestOf(file) {
  const hash = createHash('sha256');
  await pipeline(Readable.from([await readFile(file)]), hash);
  return hash.digest('hex');
}

async function matches(file, expected) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size !== expected.sizeBytes) return false;
  return (await digestOf(file)) === expected.sha256;
}

/**
 * The pinned entry for `target`, with the ABI proved against `abi` first: a
 * pin for another binding ABI is a stale pin, and no target's bytes are worth
 * downloading until that is settled.
 */
export function resolvePin(pin, target, abi) {
  if (pin.abi === null || pin.tag === null) {
    throw new FetchFailure('runtime.no_prebuilt', `${PIN_FILE} pins no published runtime yet; build from source or publish one with scripts/native-runtime/publish-runtime.mjs`);
  }
  if (pin.abi !== abi) {
    throw new FetchFailure(
      'runtime.abi_mismatch',
      `pinned runtime ${pin.version} (${pin.tag}) satisfies binding ABI ${pin.abi} but this checkout requires ABI ${abi}; publish a runtime built from this revision instead of installing a mismatched one`,
    );
  }
  const entry = pin.targets[target];
  if (entry === undefined) throw new FetchFailure('runtime.unsupported_target', `${target} is not a native runtime target`);
  if (entry === null) {
    throw new FetchFailure('runtime.no_prebuilt_for_target', `no prebuilt runtime is published for ${target} at ${pin.tag}; build it from source`);
  }
  return entry;
}

export async function fetchRuntime({ target = tripleForNode(), root, baseUrl, abi } = {}) {
  const pin = await readReleasePin();
  const required = abi ?? requiredAbi();
  const entry = resolvePin(pin, target, required);
  const origin = (baseUrl ?? process.env.SIMFORGE_NATIVE_RUNTIME_BASE_URL ?? `https://github.com/${pin.repository}/releases/download/${pin.tag}`).replace(/\/+$/u, '');
  const url = `${origin}/${entry.archive}`;
  const cache = path.join(root ?? defaultRuntimeRoot(), 'downloads');
  const archive = path.join(cache, entry.archive);
  const expected = { sha256: entry.sha256, sizeBytes: entry.sizeBytes };

  let cached = true;
  if (!(await matches(archive, expected))) {
    cached = false;
    await mkdir(cache, { recursive: true });
    const temporary = `${archive}.${process.pid}.tmp`;
    const response = await fetch(url).catch((error) => {
      throw new FetchFailure('runtime.download_failed', `${url}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!response.ok || !response.body) throw new FetchFailure('runtime.download_failed', `${url} answered ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o644 }));
    const info = await stat(temporary);
    const sha256 = await digestOf(temporary);
    if (sha256 !== expected.sha256 || info.size !== expected.sizeBytes) {
      await rm(temporary, { force: true });
      // Name the check that failed: a corrupted download, a truncated
      // download and a wrong pin have the same symptom and different
      // remedies, and "install failed" tells the reader none of them.
      const differs = [
        sha256 === expected.sha256 ? null : `sha256 is ${sha256}, the pin declares ${expected.sha256}`,
        info.size === expected.sizeBytes ? null : `length is ${info.size} bytes, the pin declares ${expected.sizeBytes}`,
      ].filter((difference) => difference !== null);
      throw new FetchFailure(
        'runtime.digest_mismatch',
        `${url} does not match ${path.basename(PIN_FILE)}: ${differs.join('; ')}. The bytes were discarded and nothing was installed. If the download was corrupted or truncated, retrying fetches it again; if the asset really is these bytes, the pin names the wrong ${sha256 === expected.sha256 ? 'length' : 'digest'} and must be rewritten by publish-runtime.mjs from the build that produced them.`,
      );
    }
    await rename(temporary, archive);
  }

  return {
    schema: 'simforge.native-runtime-fetch/v1',
    archive,
    target,
    url,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
    version: pin.version,
    revision: pin.revision,
    abi: pin.abi,
    cached,
    gpuInterop: entry.gpuInterop,
    tested: entry.tested,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await fetchRuntime(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    fail(error instanceof FetchFailure ? error.code : 'runtime.fetch_failed', error instanceof Error ? error.message : String(error));
  }
}
