import {
  read, write, VK_FORMAT_UNDEFINED, VK_FORMAT_BC1_RGB_UNORM_BLOCK,
  VK_FORMAT_BC7_SRGB_BLOCK, VK_FORMAT_ASTC_4x4_UNORM_BLOCK, VK_FORMAT_ASTC_12x12_SRGB_BLOCK,
} from 'three/addons/libs/ktx-parse.module.js';

/** Browser-safe, lossless mip-tail selection shared by the publisher and loader. */
export function selectKtx2MipLevels(buffer, maxDimension) {
  if (!(maxDimension > 0)) throw new Error('KTX2 mip limit must be positive');
  const container = read(new Uint8Array(buffer));
  if (container.pixelDepth > 0) return { buffer, forceRgba: false };
  let first = 0;
  while (first + 1 < container.levels.length
    && Math.max(container.pixelWidth >> first, container.pixelHeight >> first) > maxDimension) first++;
  const blockAligned = () => Math.max(1, container.pixelWidth >> first) % 4 === 0
    && Math.max(1, container.pixelHeight >> first) % 4 === 0;
  const nativeBlocks = (container.vkFormat >= VK_FORMAT_BC1_RGB_UNORM_BLOCK && container.vkFormat <= VK_FORMAT_BC7_SRGB_BLOCK)
    || (container.vkFormat >= VK_FORMAT_ASTC_4x4_UNORM_BLOCK && container.vkFormat <= VK_FORMAT_ASTC_12x12_SRGB_BLOCK);
  // Existing native blocks cannot change their pixels: retain a legal authored base.
  if (nativeBlocks) while (first > 0 && !blockAligned()) first--;
  // This also applies to a previously sliced Basis container (first === 0).
  const forceRgba = container.vkFormat === VK_FORMAT_UNDEFINED && !blockAligned();
  if (first === 0) return { buffer, forceRgba };
  container.pixelWidth = Math.max(1, container.pixelWidth >> first);
  container.pixelHeight = Math.max(1, container.pixelHeight >> first);
  container.levels = container.levels.slice(first);
  container.levelCount = container.levels.length;
  if (container.globalData) {
    const imagesPerLevel = Math.max(1, container.layerCount) * container.faceCount;
    container.globalData.imageDescs = container.globalData.imageDescs.slice(first * imagesPerLevel);
  }
  const bytes = write(container, { keepWriter: true });
  return { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), forceRgba };
}

/** Metadata for admission, without inflating/transcoding any pixel payload. */
export function ktx2MipInfo(buffer) {
  const container = read(new Uint8Array(buffer));
  return {
    width: container.pixelWidth, height: container.pixelHeight,
    levels: container.levels.length, vkFormat: container.vkFormat,
    supercompressionScheme: container.supercompressionScheme,
    residentBytes: container.levels.reduce((sum, level) => sum + level.uncompressedByteLength, 0),
  };
}
