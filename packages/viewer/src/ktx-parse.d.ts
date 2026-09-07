/**
 * three bundles ktx-parse for its KTX2Loader without types. Only the surface
 * the texture loader uses to crop authored mip levels is declared, so a wrong
 * field name is a compile error rather than `any`.
 */
declare module 'three/addons/libs/ktx-parse.module.js' {
  export interface KTX2Level {
    levelData: Uint8Array;
    uncompressedByteLength: number;
  }

  export interface KTX2GlobalDataBasisLZ {
    endpointCount: number;
    selectorCount: number;
    imageDescs: {
      imageFlags: number;
      rgbSliceByteOffset: number;
      rgbSliceByteLength: number;
      alphaSliceByteOffset: number;
      alphaSliceByteLength: number;
    }[];
    endpointsData: Uint8Array;
    selectorsData: Uint8Array;
    tablesData: Uint8Array;
    extendedData: Uint8Array;
  }

  export interface KTX2Container {
    vkFormat: number;
    typeSize: number;
    pixelWidth: number;
    pixelHeight: number;
    pixelDepth: number;
    layerCount: number;
    faceCount: number;
    levelCount: number;
    supercompressionScheme: number;
    levels: KTX2Level[];
    dataFormatDescriptor: { texelBlockDimension: [number, number, number, number] }[];
    keyValue: { [key: string]: string | Uint8Array };
    globalData: KTX2GlobalDataBasisLZ | null;
  }

  export const KHR_SUPERCOMPRESSION_NONE: number;
  export const KHR_SUPERCOMPRESSION_BASISLZ: number;

  export const VK_FORMAT_UNDEFINED: number;
  export const VK_FORMAT_BC1_RGB_UNORM_BLOCK: number;
  export const VK_FORMAT_BC7_SRGB_BLOCK: number;

  /** An empty 2D container with one layer and face, no levels and a default DFD. */
  export function createDefaultContainer(): KTX2Container;
  /** Level data points into `data`; the source buffer must outlive the container. */
  export function read(data: Uint8Array): KTX2Container;
  /** Copies level data into a fresh KTX2 file. */
  export function write(container: KTX2Container, options?: { keepWriter?: boolean }): Uint8Array;
}
