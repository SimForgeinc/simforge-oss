import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import { hostname, loadavg, platform, release, totalmem } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) values.set(key, 'true');
    else { values.set(key, next); index += 1; }
  }
  return values;
}

export function boolArg(args, name) { return args.get(name) === 'true'; }
export function numberArg(args, name, fallback) {
  const value = args.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be numeric`);
  return parsed;
}
export function requireArg(args, name) {
  const value = args.get(name);
  if (!value || value === 'true') throw new Error(`--${name} is required`);
  return value;
}

export function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

export function run(argv, options = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(argv) || argv.length === 0) return reject(new Error('run requires a non-empty argv'));
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.detached ?? false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => { stdout.push(chunk); options.onStdout?.(chunk); });
    child.stderr.on('data', (chunk) => { stderr.push(chunk); options.onStderr?.(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code: code ?? -1,
      signal,
      pid: child.pid,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    options.onSpawn?.(child);
  });
}

export function spawnDetached(argv, options = {}) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

export function lastJson(text) {
  const values = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try { values.push(JSON.parse(trimmed)); } catch { /* CLI diagnostics are allowed beside JSON. */ }
  }
  return values.at(-1) ?? null;
}

export async function runJson(argv, options = {}) {
  const result = await run(argv, options);
  const value = lastJson(result.stdout);
  if (result.code !== 0) {
    const error = new Error(`${argv.join(' ')} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    error.result = result;
    throw error;
  }
  if (value === null) throw new Error(`${argv.join(' ')} did not emit JSON`);
  return { value, result };
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function mad(values) {
  const centre = median(values);
  if (centre === null) return null;
  return median(values.map((value) => Math.abs(value - centre)));
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  const centre = median(finite);
  return {
    n: finite.length,
    min: finite.length ? Math.min(...finite) : null,
    p50: centre,
    p95: quantile(finite, 0.95),
    p99: quantile(finite, 0.99),
    max: finite.length ? Math.max(...finite) : null,
    mad: mad(finite),
    relativeMad: centre && centre !== 0 && mad(finite) !== null ? mad(finite) / centre : null,
  };
}

export async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

export async function directoryBytes(root) {
  try {
    const info = await stat(root);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0;
    for (const entry of await readdir(root)) total += await directoryBytes(path.join(root, entry));
    return total;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function statusSample(pid) {
  return readFile(`/proc/${pid}/status`, 'utf8').then((text) => {
    const value = (name) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024;
    return { pid, rssBytes: value('VmRSS'), peakRssBytes: value('VmHWM') };
  }).catch(() => null);
}

async function processTree(rootPid) {
  const entries = [];
  try {
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const statLine = await readFile(`/proc/${name}/stat`, 'utf8');
        const close = statLine.lastIndexOf(')');
        const fields = statLine.slice(close + 2).split(' ');
        entries.push({ pid: Number(name), ppid: Number(fields[1]) });
      } catch { /* process exited between directory listing and read */ }
    }
  } catch { return [rootPid]; }
  const children = new Map();
  for (const entry of entries) children.set(entry.pid, [...(children.get(entry.ppid) ?? []), entry.pid]);
  const result = [rootPid];
  for (let index = 0; index < result.length; index += 1) result.push(...(children.get(result[index]) ?? []));
  return [...new Set(result)];
}

export async function processTreeSample(pid) {
  if (!pid) return { rssBytes: 0, peakRssBytes: 0, pids: [] };
  const samples = await Promise.all((await processTree(pid)).map(statusSample));
  const valid = samples.filter(Boolean);
  return {
    rssBytes: valid.reduce((sum, item) => sum + item.rssBytes, 0),
    peakRssBytes: Math.max(0, ...valid.map((item) => item.peakRssBytes)),
    pids: valid.map((item) => item.pid),
  };
}

export async function gpuSample() {
  const result = await run(['nvidia-smi', '--query-gpu=uuid,name,driver_version,clocks.current.graphics,clocks.max.graphics,memory.used,memory.total,utilization.gpu,power.draw,power.limit', '--format=csv,noheader,nounits']);
  if (result.code !== 0) return null;
  const fields = result.stdout.trim().split(',').map((item) => item.trim());
  if (fields.length < 10) return null;
  const number = (value) => Number(String(value).replace(/[^0-9.\-]/g, ''));
  return {
    uuid: fields[0], name: fields[1], driverVersion: fields[2],
    clockMHz: number(fields[3]), maxClockMHz: number(fields[4]), memoryUsedMiB: number(fields[5]),
    memoryTotalMiB: number(fields[6]), utilizationPercent: number(fields[7]), powerW: number(fields[8]), powerLimitW: number(fields[9]),
  };
}

export async function machineState() {
  const gpu = await gpuSample();
  return {
    hostname: hostname(), platform: platform(), kernel: release(), cpuCount: cpus().length,
    loadAverage: loadavg(), totalMemoryBytes: totalmem(),
    gpu,
    gpuClockPolicy: {
      pinned: false,
      reason: 'Clock/power pinning was not applied on the shared host; runs use repeats and robust medians instead.',
      observedClockMHz: gpu?.clockMHz ?? null,
      maxClockMHz: gpu?.maxClockMHz ?? null,
    },
  };
}

export async function collectDirectoryFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files.push(file);
    }
  }
  await visit(root);
  return files;
}

export async function removeIfExists(file) {
  await rm(file, { recursive: true, force: true });
}

export function stageSummaryFromTimings(timings = {}) {
  const total = (name) => Number(timings[name]?.totalMs ?? 0);
  const stages = {
    simulationSteppingMs: total('worldUpdate'),
    frameRasterisationMs: total('scenePass'),
    sensorSynthesisMs: total('readback'),
    encodeFinaliseMs: total('encoding') + total('visualization') + total('artifactWrite'),
  };
  stages.instrumentedTotalMs = Object.values(stages).reduce((sum, value) => sum + value, 0);
  return stages;
}

export function progressFraction(value) {
  if (typeof value === 'number') return value > 1 ? value / 100 : value;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['fraction', 'progress', 'progressFraction', 'percent', 'progressPercent']) {
    const candidate = progressFraction(value[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}
EOF