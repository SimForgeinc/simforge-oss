export declare const TEXTURE_TIERS_REVISION: string;
export declare const TEXTURE_VARIANTS: readonly string[];
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
}): Promise<TextureTierBuildReport>;
