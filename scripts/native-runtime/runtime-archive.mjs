// Runtime archive I/O without external tools. The distributable is a
// gzip-compressed POSIX ustar archive (`.tar.gz`) so it stays inspectable
// with any tar, but it is produced and consumed here with Node's zlib and a
// minimal ustar writer/reader, so the same code runs on Windows, macOS and
// Linux packaging or installing hosts.
//
// Archive contents (see package-runtime.mjs):
//   bin/<runner> bin/<render service> bin/runtime-manifest.json
//   lib/<render library> share/** wheels/*.whl (optional) SHA256SUMS
//
// SHA256SUMS lists every regular file except itself as `<sha256>  <path>`
// (sha256sum format) with forward-slash paths sorted bytewise.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export const CHECKSUMS_FILE = 'SHA256SUMS';
export const RUNTIME_MANIFEST_SCHEMA = 'simforge.native-runtime/v1';

const BLOCK = 512;
const EXECUTABLE_MODE = 0o755;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Regular files under `dir`, as forward-slash paths relative to it, sorted. */
export async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), relative)));
    else if (entry.isFile()) out.push(relative);
    else throw new Error(`${path.join(dir, entry.name)} is neither a file nor a directory; archives carry regular files only`);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Writes SHA256SUMS for every regular file under `stageDir` (except itself). */
export async function writeChecksums(stageDir) {
  const files = (await listFiles(stageDir)).filter((file) => file !== CHECKSUMS_FILE);
  const lines = [];
  for (const file of files) lines.push(`${await sha256File(path.join(stageDir, file))}  ${file}`);
  await writeFile(path.join(stageDir, CHECKSUMS_FILE), `${lines.join('\n')}\n`);
  return files;
}

function parseChecksums(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (!match) throw new Error(`${CHECKSUMS_FILE}: malformed line ${JSON.stringify(line)}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Verifies an extracted (or staged) runtime tree: SHA256SUMS covers exactly
 * the files present and every digest matches; the runtime manifest parses,
 * describes bin/<binary.name>, and every component is present with its
 * declared sha256/sizeBytes. Returns the parsed manifest.
 */
export async function verifyRuntimeStage(dir) {
  const files = await listFiles(dir);
  if (!files.includes(CHECKSUMS_FILE)) throw new Error(`${dir}: ${CHECKSUMS_FILE} missing`);
  const sums = parseChecksums(await readFile(path.join(dir, CHECKSUMS_FILE), 'utf8'));
  for (const file of files) {
    if (file === CHECKSUMS_FILE) continue;
    const expected = sums.get(file);
    if (!expected) throw new Error(`${file} is not listed in ${CHECKSUMS_FILE}`);
    const actual = await sha256File(path.join(dir, file));
    if (actual !== expected) throw new Error(`${file}: sha256 ${actual}, ${CHECKSUMS_FILE} lists ${expected}`);
  }
  for (const listed of sums.keys()) {
    if (!files.includes(listed)) throw new Error(`${listed} is listed in ${CHECKSUMS_FILE} but absent`);
  }

  const manifestPath = path.join(dir, 'bin', 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isRecord(manifest) || manifest.schema !== RUNTIME_MANIFEST_SCHEMA) {
    throw new Error(`${manifestPath}: schema is not ${RUNTIME_MANIFEST_SCHEMA}`);
  }
  if (!isRecord(manifest.binary) || typeof manifest.binary.name !== 'string' || typeof manifest.target !== 'string') {
    throw new Error(`${manifestPath}: binary.name and target are required`);
  }
  await verifyDigest(dir, `bin/${manifest.binary.name}`, manifest.binary, 'runtime binary');
  if (!Array.isArray(manifest.components)) throw new Error(`${manifestPath}: components must be an array`);
  for (const component of manifest.components) {
    if (!isRecord(component) || typeof component.install !== 'string') throw new Error(`${manifestPath}: malformed component`);
    await verifyDigest(dir, component.install, component, `component ${component.name ?? component.install}`);
  }
  return manifest;
}

async function verifyDigest(dir, relative, expected, what) {
  const file = path.join(dir, ...relative.split('/'));
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new Error(`${what} ${relative} is missing`);
  }
  if (info.size !== expected.sizeBytes) throw new Error(`${what} ${relative}: ${info.size} bytes, manifest declares ${expected.sizeBytes}`);
  const actual = await sha256File(file);
  if (actual !== expected.sha256) throw new Error(`${what} ${relative}: sha256 ${actual}, manifest declares ${expected.sha256}`);
}

// --- ustar ---------------------------------------------------------------

function octal(value, width) {
  const text = value.toString(8);
  if (text.length > width - 1) throw new Error(`ustar field overflow: ${value} does not fit ${width} octal digits`);
  return `${text.padStart(width - 1, '0')}\0`;
}

function splitName(name) {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { name, prefix: '' };
  const cut = name.lastIndexOf('/', 155);
  if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155) {
    throw new Error(`path too long for ustar: ${name}`);
  }
  return { name: name.slice(cut + 1), prefix: name.slice(0, cut) };
}

function header({ name, size, mode, mtime, type }) {
  const block = Buffer.alloc(BLOCK);
  const split = splitName(name);
  block.write(split.name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100);
  block.write(octal(0, 8), 108); // uid
  block.write(octal(0, 8), 116); // gid
  block.write(octal(size, 12), 124);
  block.write(octal(mtime, 12), 136);
  block.write('        ', 148); // checksum placeholder
  block.write(type, 156, 1);
  block.write('ustar\0', 257);
  block.write('00', 263);
  block.write(split.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function padding(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/**
 * Packs `stageDir` into `archivePath` as gzip'd ustar. Directories are
 * emitted before their files; `bin/` entries are 0755, everything else 0644;
 * mtime is `mtime` (seconds, default 0) so identical trees give identical
 * archives regardless of when they were staged.
 */
export async function createRuntimeArchive({ stageDir, archivePath, mtime = 0 }) {
  const files = await listFiles(stageDir);
  if (!files.includes(CHECKSUMS_FILE)) throw new Error(`${stageDir}: run writeChecksums first`);
  const dirs = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) dirs.add(parts.slice(0, depth).join('/'));
  }
  async function* entries() {
    for (const dir of [...dirs].sort()) {
      yield header({ name: `${dir}/`, size: 0, mode: DIR_MODE, mtime, type: '5' });
    }
    for (const file of files) {
      const full = path.join(stageDir, ...file.split('/'));
      const info = await stat(full);
      const mode = file.startsWith('bin/') ? EXECUTABLE_MODE : FILE_MODE;
      yield header({ name: file, size: info.size, mode, mtime, type: '0' });
      const handle = await open(full, 'r');
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) yield chunk;
      } finally {
        await handle.close();
      }
      yield padding(info.size);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  await mkdir(path.dirname(archivePath), { recursive: true });
  await pipeline(entries(), createGzip({ level: 9 }), createWriteStream(archivePath));
  return { files };
}

function parseHeader(block) {
  if (block.every((byte) => byte === 0)) return null;
  const field = (start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
  const numeric = (start, length) => Number.parseInt(field(start, length).trim() || '0', 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index];
  if (sum !== numeric(148, 8)) throw new Error('tar header checksum mismatch; archive is corrupt');
  const magic = field(257, 6);
  const prefix = magic === 'ustar' ? field(345, 155) : '';
  const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
  return { name, mode: numeric(100, 8), size: numeric(124, 12), type: field(156, 1) || '0' };
}

function safeRelative(name) {
  const normalized = name.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const parts = normalized.split('/');
  if (!normalized || path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`archive entry ${JSON.stringify(name)} escapes the destination`);
  }
  return parts;
}

/**
 * Extracts a runtime archive into `destDir` (created). Only regular files
 * and directories are accepted; anything else (links, devices) is an error,
 * never silently skipped. File modes are applied on POSIX hosts.
 */
export async function extractRuntimeArchive(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });
  const files = [];
  // pipeline() (not pipe()) so a failing file read destroys the gunzip
  // stream and surfaces here instead of stalling the iteration.
  const source = createGunzip();
  const reading = pipeline(createReadStream(archivePath), source);
  let pending = Buffer.alloc(0);
  let current = null; // { path, remaining, handle, mode }

  const drain = async (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (current) {
        const take = Math.min(current.remaining, pending.length);
        if (take > 0) {
          await current.handle.write(pending.subarray(0, take));
          pending = pending.subarray(take);
          current.remaining -= take;
        }
        if (current.remaining > 0) return;
        const pad = padding(current.size).length;
        if (pending.length < pad) return;
        pending = pending.subarray(pad);
        await current.handle.close();
        if (process.platform !== 'win32') await chmod(current.path, current.mode & 0o777);
        current = null;
        continue;
      }
      if (pending.length < BLOCK) return;
      const head = parseHeader(pending.subarray(0, BLOCK));
      pending = pending.subarray(BLOCK);
      if (head === null) continue; // end-of-archive block(s)
      const parts = safeRelative(head.name);
      const target = path.join(destDir, ...parts);
      if (head.type === '5') {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (head.type !== '0') throw new Error(`archive entry ${head.name} has unsupported type ${JSON.stringify(head.type)}`);
      await mkdir(path.dirname(target), { recursive: true });
      const handle = await open(target, 'wx');
      files.push(parts.join('/'));
      current = { path: target, remaining: head.size, size: head.size, handle, mode: head.mode || FILE_MODE };
    }
  };

  for await (const chunk of source) await drain(chunk);
  await reading;
  if (current) throw new Error(`archive ended inside ${current.path}; truncated`);
  if (pending.some((byte) => byte !== 0)) throw new Error('trailing data after end of archive');
  return { files: files.sort() };
}
