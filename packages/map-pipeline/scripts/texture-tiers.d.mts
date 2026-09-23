export declare const TEXTURE_TIERS_REVISION: string;
export declare const TEXTURE_VARIANTS: readonly string[];
export declare const TEXTURE_TIERS_MIN_FREE_BYTES: number;
export interface TextureTierBuildReport {
  sourceRoot: string;
  outputRoot: string;
  sourceManifestSha256: string;
  wallSeconds: number;
  variants: Record<string, { images: number; bytes: number; residentBytes: number; rgbaImages: number; producedObjects: number; reusedObjects: number }>;
}
export declare function buildTextureTiers(options: {
  sourceRoot: string;
  outputRoot?: string;
  ktxBin?: string;
  variants?: readonly string[];
  concurrency?: number;
  /** Refuse to start (or continue) below this much free space; default TEXTURE_TIERS_MIN_FREE_BYTES (25 GB). */
  minFreeBytes?: number;
}): Promise<TextureTierBuildReport>;
