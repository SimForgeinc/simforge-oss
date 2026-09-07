import type { Writable } from "node:stream";
import { readLocalObject, streamLocalObject } from "@/app/lib/s3/s3-object";
import type { ExportArtifact } from "./sources";

/**
 * Streaming ZIP32 / ustar writers over the local object store.
 *
 * Ported from the SimCloud export runtime so a package produced locally has the
 * same layout, entry naming and headers as one produced by the managed
 * workers. ZIP entries use data descriptors (flag 0x0008) so a stream can be
 * emitted without knowing sizes or CRCs up front; ZIP32 limits are enforced.
 */

export type ZipEntry = { name: string; crc32: number; size: number; offset: number };

function tarChecksum(header: Buffer) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) sum += header[index]!;
  return sum;
}

const ZIP_CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  ZIP_CRC_TABLE[n] = c >>> 0;
}

export function zipCrc32(buffer: Uint8Array, previous = 0) {
  let crc = previous ^ 0xffffffff;
  for (const byte of buffer) {
    crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertZip32(value: number, label: string) {
  if (value > 0xffffffff) {
    throw new Error(`ZIP package ${label} exceeds ZIP32 limit; split the export or use tar delivery.`);
  }
}

function zipLocalFileHeader(name: string) {
  const fileName = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30 + fileName.length, 0);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0008, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);
  fileName.copy(header, 30);
  return header;
}

function zipDataDescriptor(crc32: number, size: number) {
  assertZip32(size, "entry size");
  const descriptor = Buffer.alloc(16, 0);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32 >>> 0, 4);
  descriptor.writeUInt32LE(size >>> 0, 8);
  descriptor.writeUInt32LE(size >>> 0, 12);
  return descriptor;
}

function zipCentralDirectoryHeader(entry: ZipEntry) {
  const fileName = Buffer.from(entry.name, "utf8");
  assertZip32(entry.size, "entry size");
  assertZip32(entry.offset, "local header offset");
  const header = Buffer.alloc(46 + fileName.length, 0);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0008, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(entry.crc32 >>> 0, 16);
  header.writeUInt32LE(entry.size >>> 0, 20);
  header.writeUInt32LE(entry.size >>> 0, 24);
  header.writeUInt16LE(fileName.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0o100644 * 0x10000, 38);
  header.writeUInt32LE(entry.offset >>> 0, 42);
  fileName.copy(header, 46);
  return header;
}

function zipEndOfCentralDirectory(entryCount: number, size: number, offset: number) {
  assertZip32(entryCount, "entry count");
  assertZip32(size, "central directory size");
  assertZip32(offset, "central directory offset");
  const footer = Buffer.alloc(22, 0);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(size >>> 0, 12);
  footer.writeUInt32LE(offset >>> 0, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number) {
  const text = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function tarHeader(name: string, size: number, mode = 0o644) {
  const header = Buffer.alloc(512, 0);
  const safeName = name.length > 100 ? name.slice(-100) : name;
  header.write(safeName, 0, Math.min(Buffer.byteLength(safeName), 100), "utf8");
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = tarChecksum(header);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** Back-pressure aware write: resolves once the sink can take more bytes. */
function write(sink: Writable, chunk: Buffer): Promise<void> {
  if (sink.write(chunk)) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onError = (error: Error) => {
    sink.off("drain", onDrain);
    reject(error);
  };
  const onDrain = () => {
    sink.off("error", onError);
    resolve();
  };
  sink.once("drain", onDrain);
  sink.once("error", onError);
  return promise;
}

function artifactLocation(artifact: ExportArtifact) {
  if (!artifact.s3_key) throw new Error(`Artifact ${artifact.id} has no stored object key.`);
  return { bucket: artifact.s3_bucket, key: artifact.s3_key };
}

export async function readArtifactBuffer(artifact: ExportArtifact): Promise<Buffer> {
  const { bucket, key } = artifactLocation(artifact);
  return Buffer.from(await readLocalObject(bucket, key));
}

export async function readArtifactJson<T = unknown>(artifact: ExportArtifact): Promise<T> {
  return JSON.parse((await readArtifactBuffer(artifact)).toString("utf8")) as T;
}

export async function writeBufferToTar(sink: Writable, entryName: string, buffer: Buffer) {
  await write(sink, tarHeader(entryName, buffer.length));
  await write(sink, buffer);
  const remainder = buffer.length % 512;
  if (remainder) await write(sink, Buffer.alloc(512 - remainder, 0));
}

export async function writeArtifactToTar(sink: Writable, artifact: ExportArtifact, entryName: string) {
  const { bucket, key } = artifactLocation(artifact);
  const size = Number(artifact.size_bytes ?? 0);
  await write(sink, tarHeader(entryName, size));
  let written = 0;
  for await (const chunk of streamLocalObject(bucket, key)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    written += buffer.length;
    await write(sink, buffer);
  }
  if (written !== size) {
    throw new Error(
      `Artifact ${artifact.id} is ${written} bytes on disk but registered as ${size} bytes.`,
    );
  }
  const remainder = size % 512;
  if (remainder) await write(sink, Buffer.alloc(512 - remainder, 0));
}

export async function finishTar(sink: Writable) {
  await write(sink, Buffer.alloc(1024, 0));
}

export async function writeBufferToZip(
  sink: Writable,
  entryName: string,
  buffer: Buffer,
  entries: ZipEntry[],
  byteOffset: number,
): Promise<number> {
  const localHeader = zipLocalFileHeader(entryName);
  await write(sink, localHeader);
  await write(sink, buffer);
  const crc32 = zipCrc32(buffer);
  const descriptor = zipDataDescriptor(crc32, buffer.length);
  await write(sink, descriptor);
  entries.push({ name: entryName, crc32, size: buffer.length, offset: byteOffset });
  return byteOffset + localHeader.length + buffer.length + descriptor.length;
}

export async function writeArtifactToZip(
  sink: Writable,
  artifact: ExportArtifact,
  entryName: string,
  entries: ZipEntry[],
  byteOffset: number,
): Promise<number> {
  const { bucket, key } = artifactLocation(artifact);
  const localHeader = zipLocalFileHeader(entryName);
  await write(sink, localHeader);
  let offset = byteOffset + localHeader.length;
  let crc32 = 0;
  let size = 0;
  for await (const chunk of streamLocalObject(bucket, key)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    crc32 = zipCrc32(buffer, crc32);
    size += buffer.length;
    assertZip32(size, "entry size");
    offset += buffer.length;
    await write(sink, buffer);
  }
  const descriptor = zipDataDescriptor(crc32, size);
  await write(sink, descriptor);
  offset += descriptor.length;
  entries.push({ name: entryName, crc32, size, offset: byteOffset });
  return offset;
}

export async function finishZip(sink: Writable, entries: ZipEntry[], byteOffset: number) {
  const centralDirectoryOffset = byteOffset;
  let offset = byteOffset;
  for (const entry of entries) {
    const header = zipCentralDirectoryHeader(entry);
    await write(sink, header);
    offset += header.length;
  }
  const centralDirectorySize = offset - centralDirectoryOffset;
  const footer = zipEndOfCentralDirectory(entries.length, centralDirectorySize, centralDirectoryOffset);
  await write(sink, footer);
  return offset + footer.length;
}
