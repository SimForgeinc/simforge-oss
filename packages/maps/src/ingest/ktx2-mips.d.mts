export declare function selectKtx2MipLevels(buffer: ArrayBuffer, maxDimension: number): { buffer: ArrayBuffer; forceRgba: boolean };
export declare function ktx2MipInfo(buffer: ArrayBuffer): {
  width: number; height: number; levels: number; vkFormat: number;
  supercompressionScheme: number; residentBytes: number;
};
