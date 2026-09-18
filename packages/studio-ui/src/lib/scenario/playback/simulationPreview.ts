import { sha256BytesAsync } from "@simforge-oss/engine/hash";
import type { ScenarioSimulationPreviewDto } from "../contracts";
import { fetchContentAddressedArtifact } from "../artifact-cache";
import { parsePlaybackPair, type PlaybackBundle } from "@simforge-oss/playback";
import { admitSimulationPreview, storedSimulationPreview, type SimulationPreviewRuntime } from "@simforge-oss/playback";

export type { SimulationPreviewRuntime } from "@simforge-oss/playback";

export async function encodeSimulationPreview(bundle: PlaybackBundle, draftVersion: number, runtime: SimulationPreviewRuntime) {
  const value = storedSimulationPreview(bundle, draftVersion, runtime);
  const compressed = await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const bytes = new Uint8Array(compressed);
  return { bytes, sha256: await sha256BytesAsync(bytes) };
}

export async function downloadSimulationPreview(
  descriptor: ScenarioSimulationPreviewDto,
  runtime: SimulationPreviewRuntime,
  signal?: AbortSignal,
): Promise<PlaybackBundle> {
  const bytes = await fetchContentAddressedArtifact(
    descriptor.downloadUrl,
    { sha256: descriptor.sha256, sizeBytes: descriptor.sizeBytes },
    { signal, label: "Saved simulation" },
  );
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const value: unknown = JSON.parse(json);
  return admitSimulationPreview(value, { draftVersion: descriptor.draftVersion, runtime });
}
