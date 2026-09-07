import assert from "node:assert/strict";
import test from "node:test";
import { unsignedMachO } from "./stage-manifest.mjs";

function unsignedImage() {
  const bytes = Buffer.alloc(4120);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(144, 20);
  for (const [offset, name, fileOffset, fileSize] of [
    [32, "__TEXT", 0, 4096],
    [104, "__LINKEDIT", 4096, 24],
  ]) {
    bytes.writeUInt32LE(0x19, offset);
    bytes.writeUInt32LE(72, offset + 4);
    bytes.write(name, offset + 8, "ascii");
    bytes.writeBigUInt64LE(4096n, offset + 32);
    bytes.writeBigUInt64LE(BigInt(fileOffset), offset + 40);
    bytes.writeBigUInt64LE(BigInt(fileSize), offset + 48);
  }
  bytes[2048] = 0x4a;
  bytes.fill(0x63, 4096);
  return bytes;
}

function withSignature(image, signatureBytes) {
  const start = Math.ceil(image.length / 16) * 16;
  const bytes = Buffer.alloc(start + signatureBytes, 0);
  image.copy(bytes);
  bytes.writeUInt32LE(3, 16);
  bytes.writeUInt32LE(160, 20);
  bytes.writeUInt32LE(0x1d, 176);
  bytes.writeUInt32LE(16, 180);
  bytes.writeUInt32LE(start, 184);
  bytes.writeUInt32LE(signatureBytes, 188);
  bytes.writeBigUInt64LE(8192n, 136);
  bytes.writeBigUInt64LE(BigInt(bytes.length - 4096), 152);
  bytes.fill(0xa3, start);
  return bytes;
}

test("signature layout changes preserve the pinned unsigned payload digest", () => {
  const original = unsignedImage();
  const digest = unsignedMachO(original).sha256;
  assert.equal(unsignedMachO(withSignature(original, 64)).sha256, digest);
  assert.equal(unsignedMachO(withSignature(original, 176)).sha256, digest);
});

test("code and link-edit table mutations cannot hide behind a replacement signature", () => {
  const original = unsignedImage();
  const digest = unsignedMachO(original).sha256;
  for (const offset of [2048, 4112]) {
    const modified = withSignature(original, 64);
    modified[offset] ^= 1;
    assert.notEqual(unsignedMachO(modified).sha256, digest);
  }
});

test("data after a declared signature is rejected rather than excluded from integrity", () => {
  const modified = Buffer.concat([withSignature(unsignedImage(), 64), Buffer.from([1])]);
  assert.throws(() => unsignedMachO(modified), Error);
});
