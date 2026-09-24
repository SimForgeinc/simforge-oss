/**
 * Adapter fingerprint for the native (Bevy/wgpu) golden store.
 *
 * Goldens are recorded and verified on Mesa lavapipe, not on a GPU: see
 * `lavapipeIcd`. The fingerprint keys a golden table to the lavapipe build
 * and the CPU it ran on (docs/engineering/native-golden-ci.md); a new Mesa,
 * LLVM or CPU model needs its own recorded table.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

async function osPrettyName() {
  const rel = await readFile('/etc/os-release', 'utf8').catch(() => '');
  return rel.split('\n')
    .map((line) => line.match(/^PRETTY_NAME="(.*)"$/))
    .find(Boolean)?.[1] ?? null;
}

/**
 * The adapter of record for native goldens: Mesa lavapipe (llvmpipe), the
 * CPU Vulkan driver. NVIDIA drivers are not run-to-run byte-stable for this
 * renderer (a 1 LSB difference in a few pixels between identical runs on an
 * RTX 3080 even with every draw order fixed), so pass hashes are recorded and
 * verified on lavapipe, which is. The ICD path is GOLDEN_LVP_ICD or the
 * system's `lvp_icd.json`.
 */
export function lavapipeIcd() {
  const candidates = [process.env.GOLDEN_LVP_ICD, '/usr/share/vulkan/icd.d/lvp_icd.json', '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json'];
  const icd = candidates.find((candidate) => candidate && safe(() => execFileSync('test', ['-f', candidate]) !== null, false));
  if (!icd) throw new Error('lavapipe ICD not found (install mesa-vulkan-drivers, or set GOLDEN_LVP_ICD)');
  return icd;
}

/** The renderer's environment on the adapter of record. */
export function lavapipeEnv(icd = lavapipeIcd()) {
  return { VK_ICD_FILENAMES: icd, SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER: '1', WGPU_BACKEND: 'vulkan' };
}

/** deviceName / driverInfo of the lavapipe adapter, from `vulkaninfo --summary`. */
export function lavapipeAdapter(icd = lavapipeIcd()) {
  const out = safe(() => execFileSync('vulkaninfo', ['--summary'], { encoding: 'utf8', env: { ...process.env, VK_ICD_FILENAMES: icd } }), null);
  if (!out) throw new Error('vulkaninfo failed for the lavapipe ICD (install vulkan-tools)');
  const field = (name) => out.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
  const adapter = { icd, deviceName: field('deviceName'), driverName: field('driverName'), driverInfo: field('driverInfo') };
  if (adapter.driverName !== 'llvmpipe') throw new Error(`the lavapipe ICD reported driver ${adapter.driverName}, not llvmpipe`);
  return adapter;
}

/**
 * gpuFingerprint = first 16 hex of sha256 over canonical JSON of the
 * lavapipe identity: deviceName (LLVM version and vector width),
 * driverInfo (Mesa + LLVM builds), the CPU model (llvmpipe's generated code
 * depends on the CPU's features) and arch. The kernel is not part of it.
 */
export async function collectNativeHardware() {
  const adapter = lavapipeAdapter();
  const host = {
    osPrettyName: await osPrettyName(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    hostname: os.hostname(),
    adapter,
  };
  const fingerprintSource = { adapter: { deviceName: adapter.deviceName, driverInfo: adapter.driverInfo }, cpuModel: host.cpuModel, arch: host.arch };
  const gpuFingerprint = createHash('sha256').update(JSON.stringify(fingerprintSource)).digest('hex').slice(0, 16);
  return { collectedAt: new Date().toISOString(), gpuFingerprint, host };
}
