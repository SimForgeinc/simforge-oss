export declare const BROWSER_PACK_SCHEMA: 'simforge.map-browser-pack.v1';
export declare const BROWSER_PACK_REVISION: string;
export declare const BROWSER_PACK_CHUNK_BYTES: number;
export declare function initialFocus(manifest: unknown): number[];
export declare function streamingOrder(manifest: unknown): { focus: number[]; core: string[]; vegetation: string[] };
export declare function uastcRgbMissing(bytes: Uint8Array | ArrayBuffer): Promise<boolean>;
export interface BrowserPackBuildReport {
  sourceRoot: string;
  outputRoot: string;
  sourceManifestSha256: string;
  wallSeconds: number;
  packs: Record<string, { chunks: number; coreBytes: number; vegetationBytes: number; textureBytes: number; members: number; albedoRgbMissing: number }>;
}
export declare function buildBrowserPacks(options: {
  sourceRoot: string;
  outputRoot?: string;
  tiers?: readonly string[];
  chunkBytes?: number;
}): Promise<BrowserPackBuildReport>;
export declare const BROWSER_PACK_CHUNK_MAGIC: 'SFBPACK1';
export declare const BROWSER_PACK_CHUNK_HEADER_BYTES: 16;
