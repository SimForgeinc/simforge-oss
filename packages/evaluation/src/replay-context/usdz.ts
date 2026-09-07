/**
 * Minimal USDZ (ZIP) reader: archive index plus small-member extraction.
 *
 * A NuRec package is a ZIP archive, and everything the importer needs besides the Gaussian
 * weights is a plain member of it:
 *
 *   rig_trajectories.json  camera calibrations (f-theta parameters, `T_sensor_rig`) and the
 *                          recorded rig trajectory (`T_rig_worlds` + timestamps)
 *   sequence_tracks.json   recorded dynamic-actor tracks with cuboid dimensions
 *   metadata.yaml          sensor order and the scene's time range
 *   frames/<sensor>/<timestampUs>.jpeg  the recorded camera frames
 *
 * Reading them here means importing a package needs no CUDA, no torch and no renderer — the
 * calibration and motion the bundle records come from the package itself rather than from a
 * re-derivation we would have to keep in sync. Pixel work still belongs to the Python
 * measurement tool, which has the imaging stack; nothing here decodes an image.
 *
 * ZIP64 is handled because AV packages routinely exceed the 4 GiB / 65535-entry fields.
 */

import { inflateRawSync } from 'node:zlib';
import { open, type FileHandle } from 'node:fs/promises';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
/** The comment field is 16 bits, so the EOCD starts at most this far from the end. */
const EOCD_MAX_SEARCH = EOCD_MIN_SIZE + 0xffff;

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  /** 0 = stored, 8 = deflate. USDZ requires stored for referenced assets, but not for all members. */
  readonly method: number;
}

async function readSlice(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * Read the archive's central directory.
 *
 * Throws a plain `Error` rather than a refusal: a package that fails to parse is a broken
 * or wrongly-identified file, which the caller reports with its own context (a refusal for
 * a user upload, a capability error for a worker-side asset).
 */
export async function readZipIndex(archivePath: string): Promise<readonly ZipEntry[]> {
  const handle = await open(archivePath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, EOCD_MAX_SEARCH);
    const tail = await readSlice(handle, size - tailLength, tailLength);

    let eocdOffset = -1;
    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error(`${archivePath}: no ZIP end-of-central-directory record found`);

    let entryCount = tail.readUInt16LE(eocdOffset + 10);
    let directorySize = tail.readUInt32LE(eocdOffset + 12);
    let directoryOffset = tail.readUInt32LE(eocdOffset + 16);

    // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64 EOCD record.
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      let locatorOffset = -1;
      for (let i = eocdOffset - 20; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === EOCD64_LOCATOR_SIGNATURE) {
          locatorOffset = i;
          break;
        }
      }
      if (locatorOffset < 0) throw new Error(`${archivePath}: ZIP64 fields present but no ZIP64 locator`);
      const eocd64Offset = Number(tail.readBigUInt64LE(locatorOffset + 8));
      const eocd64 = await readSlice(handle, eocd64Offset, 56);
      if (eocd64.readUInt32LE(0) !== EOCD64_SIGNATURE) {
        throw new Error(`${archivePath}: ZIP64 end-of-central-directory signature mismatch`);
      }
      entryCount = Number(eocd64.readBigUInt64LE(32));
      directorySize = Number(eocd64.readBigUInt64LE(40));
      directoryOffset = Number(eocd64.readBigUInt64LE(48));
    }

    const directory = await readSlice(handle, directoryOffset, directorySize);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let i = 0; i < entryCount && cursor + 46 <= directory.length; i += 1) {
      if (directory.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) break;
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      let localHeaderOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

      if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        const extraStart = cursor + 46 + nameLength;
        let extra = extraStart;
        const extraEnd = extraStart + extraLength;
        while (extra + 4 <= extraEnd) {
          const headerId = directory.readUInt16LE(extra);
          const dataSize = directory.readUInt16LE(extra + 2);
          if (headerId === 0x0001) {
            let field = extra + 4;
            if (uncompressedSize === 0xffffffff) {
              uncompressedSize = Number(directory.readBigUInt64LE(field));
              field += 8;
            }
            if (compressedSize === 0xffffffff) {
              compressedSize = Number(directory.readBigUInt64LE(field));
              field += 8;
            }
            if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(directory.readBigUInt64LE(field));
            break;
          }
          extra += 4 + dataSize;
        }
      }

      entries.push({ name, compressedSize, uncompressedSize, localHeaderOffset, method });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** `frames/<sensorId>/<timestampUs>.<ext>` — the recorded-frame naming these packages use. */
const FRAME_MEMBER = /^frames\/([^/]+)\/(\d+)\.(jpe?g|png)$/i;

export interface RecordedFrames {
  readonly sensorId: string;
  /** Ascending capture timestamps, microseconds. */
  readonly timestampsUs: readonly number[];
  /** Archive member for each timestamp, same index order. */
  readonly members: readonly string[];
}

/**
 * Group a package's recorded camera frames by sensor.
 *
 * Sensors with no frames simply do not appear: a camera the package never recorded is not
 * something we can compare a render against, and inventing an empty timeline for it would
 * let a scene claim a view it does not have.
 */
export function recordedFrames(entries: readonly ZipEntry[]): readonly RecordedFrames[] {
  const bySensor = new Map<string, { tUs: number; member: string }[]>();
  for (const entry of entries) {
    const match = FRAME_MEMBER.exec(entry.name);
    if (match === null) continue;
    const sensorId = match[1]!;
    const list = bySensor.get(sensorId) ?? [];
    list.push({ tUs: Number(match[2]!), member: entry.name });
    bySensor.set(sensorId, list);
  }
  return [...bySensor.entries()]
    .map(([sensorId, frames]) => {
      frames.sort((a, b) => a.tUs - b.tUs);
      return {
        sensorId,
        timestampsUs: frames.map((frame) => frame.tUs),
        members: frames.map((frame) => frame.member),
      };
    })
    .sort((a, b) => a.sensorId.localeCompare(b.sensorId));
}

/** Refuse to buffer a member larger than this: the JSON sidecars are megabytes, weights are not. */
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;

/**
 * Read one member's bytes.
 *
 * Seeks the local file header to find the true payload offset — the central directory's name
 * and extra fields do not have to match the local ones, and trusting the central lengths is a
 * classic way to read a few bytes of the wrong member.
 */
export async function readZipMember(archivePath: string, entry: ZipEntry): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_MEMBER_BYTES) {
    throw new Error(`${archivePath}: member ${entry.name} is ${entry.uncompressedSize} bytes, refusing to buffer it`);
  }
  const handle = await open(archivePath, 'r');
  try {
    const header = await readSlice(handle, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) {
      throw new Error(`${archivePath}: member ${entry.name} has no local file header at ${entry.localHeaderOffset}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const payload = await readSlice(handle, entry.localHeaderOffset + 30 + nameLength + extraLength, entry.compressedSize);
    if (entry.method === 0) return payload;
    if (entry.method === 8) return inflateRawSync(payload);
    throw new Error(`${archivePath}: member ${entry.name} uses unsupported compression method ${entry.method}`);
  } finally {
    await handle.close();
  }
}

/** Read and parse a JSON member, or `undefined` when the archive does not contain it. */
export async function readZipJson(
  archivePath: string,
  entries: readonly ZipEntry[],
  name: string,
): Promise<unknown | undefined> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) return undefined;
  return JSON.parse((await readZipMember(archivePath, entry)).toString('utf8'));
}
