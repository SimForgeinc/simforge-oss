import type {
  BenchResult,
  CityViewer,
  RendererCapability,
  StreamingCoverage,
} from "@simforge-oss/viewer";
import {
  SCENARIO_AUTHORING_QUALITY_IDS,
  type ScenarioAuthoringQuality,
} from "../../../../lib/scenario/contracts";

export const RENDERING_BENCHMARK_STORAGE_KEY =
  "simforge.rendering-benchmark.v7";

export const RENDERING_BENCHMARK_CONFIGURATION = {
  viewportWidth: 1280,
  viewportHeight: 720,
  sampleDurationMs: 7_000,
  streamingSettleTimeoutMs: 15_000,
  cameraWorkload: "multi-angle-orbit",
  orbitLegs: 3,
  reversesDirection: true,
  changesPitchAndRadius: true,
} as const;

export type RenderingBenchmarkHardware = {
  browser: string;
  operatingSystem: string;
  userAgent: string;
  language: string;
  logicalProcessors: number | null;
  deviceMemoryGB: number | null;
  display: {
    width: number | null;
    height: number | null;
    pixelRatio: number;
    colorDepth: number | null;
  };
  renderer: RendererCapability | null;
  /**
   * Whether the browser reports WebGL as hardware accelerated. `null` when
   * the probe is unavailable (server render, no canvas).
   */
  hardwareAccelerated: boolean | null;
  gpuClass: GpuClass;
};

export type GpuClass = "apple" | "discrete" | "integrated" | "software" | "unknown";

export type RenderingBenchmarkResult = {
  quality: ScenarioAuthoringQuality;
  metrics: BenchResult;
  assetLoading: {
    settleMs: number;
    streamingSettled: boolean;
    requestCount: number;
    transferBytes: number;
    encodedBodyBytes: number;
    decodedBodyBytes: number;
    cachedResponses: number;
  };
  /** Layer residency when streaming settled, then again after the orbit. */
  coverage: {
    settled: StreamingCoverage;
    orbit: StreamingCoverage;
  };
};

/** Wanted city tiles with no LOD resident in either sample. */
export function missingCityTiles(result: RenderingBenchmarkResult): number {
  return Math.max(
    result.coverage.settled.city?.missingTiles ?? 0,
    result.coverage.orbit.city?.missingTiles ?? 0,
  );
}

export type RenderingBenchmarkFailure = {
  quality: ScenarioAuthoringQuality;
  message: string;
};

export type RenderingBenchmarkSnapshot = {
  /** Stable bundle identity with any expiring query signature removed. */
  manifestUrl: string;
  recommended: ScenarioAuthoringQuality;
  results: RenderingBenchmarkResult[];
  failures: RenderingBenchmarkFailure[];
  hardware: RenderingBenchmarkHardware;
  configuration: typeof RENDERING_BENCHMARK_CONFIGURATION;
  capturedAt: string;
};

const FIDELITY_ORDER: readonly ScenarioAuthoringQuality[] = ["low", "medium"];

/**
 * Pick the highest-fidelity renderer that stays comfortably interactive and
 * actually shows every building the camera asked for. A fast profile whose
 * city layer has holes is not a profile that "works". If none clear the
 * floor, prefer complete coverage first, then the lowest orbit p95 frame
 * time, instead of blindly choosing the cheapest level from average FPS alone.
 */
export function recommendRenderingPreference(
  results: readonly RenderingBenchmarkResult[],
): ScenarioAuthoringQuality | null {
  if (results.length === 0) return null;
  const byQuality = new Map(results.map((result) => [result.quality, result]));
  const interactive = [...FIDELITY_ORDER]
    .reverse()
    .find((quality) => {
      const result = byQuality.get(quality);
      return Boolean(
        result &&
          missingCityTiles(result) === 0 &&
          result.metrics.avgFps >= 40 &&
          result.metrics.orbit.p95FrameMs <= 33.3 &&
          result.metrics.orbit.p99FrameMs <= 50,
      );
    });
  if (interactive) return interactive;

  return [...results].sort((left, right) => {
    const coverageDelta = Number(missingCityTiles(right) === 0) - Number(missingCityTiles(left) === 0);
    if (coverageDelta !== 0) return coverageDelta;
    const frameDelta = left.metrics.orbit.p95FrameMs - right.metrics.orbit.p95FrameMs;
    if (Math.abs(frameDelta) > 0.25) return frameDelta;
    return (
      FIDELITY_ORDER.indexOf(right.quality) -
      FIDELITY_ORDER.indexOf(left.quality)
    );
  })[0]?.quality ?? null;
}

export function saveRenderingBenchmark(
  snapshot: RenderingBenchmarkSnapshot,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    browserStorage?.setItem(
      RENDERING_BENCHMARK_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
  } catch {
    // A completed benchmark is still useful for this session when storage is unavailable.
  }
}

export function captureRenderingBenchmarkHardware(
  viewer?: Pick<CityViewer, "getRendererCapability"> | null,
): RenderingBenchmarkHardware {
  const browserNavigator = typeof navigator === "undefined" ? null : navigator;
  const userAgent = browserNavigator?.userAgent ?? "Unavailable";
  const extendedNavigator = browserNavigator as
    | (Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } })
    | null;
  const renderer = viewer ? viewer.getRendererCapability() : null;
  return {
    browser: browserName(userAgent),
    operatingSystem:
      extendedNavigator?.userAgentData?.platform ||
      browserNavigator?.platform ||
      "Unavailable",
    userAgent,
    language: browserNavigator?.language ?? "Unavailable",
    logicalProcessors:
      typeof browserNavigator?.hardwareConcurrency === "number"
        ? browserNavigator.hardwareConcurrency
        : null,
    deviceMemoryGB:
      typeof extendedNavigator?.deviceMemory === "number"
        ? extendedNavigator.deviceMemory
        : null,
    display: {
      width: typeof screen === "undefined" ? null : screen.width,
      height: typeof screen === "undefined" ? null : screen.height,
      pixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
      colorDepth: typeof screen === "undefined" ? null : screen.colorDepth,
    },
    renderer,
    hardwareAccelerated: probeHardwareAcceleration(),
    gpuClass: classifyGpu(renderer),
  };
}

/**
 * Ask the browser whether WebGL would be a "major performance caveat" here:
 * that is the flag Chromium raises when it falls back to SwiftShader or when
 * GPU acceleration is disabled in settings or by the block list.
 */
export function probeHardwareAcceleration(): boolean | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ??
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return null;
  }
}

/**
 * Coarse adapter family from the unmasked renderer string. Integrated parts
 * (Intel Iris/UHD/HD, AMD "Radeon Graphics"/Vega APUs, mobile GPUs) are
 * separated from discrete cards because a laptop with both often hands the
 * browser the integrated one until "high performance" is forced.
 */
export function classifyGpu(capability: RendererCapability | null): GpuClass {
  if (!capability) return "unknown";
  if (capability.software) return "software";
  const label = `${capability.vendor} ${capability.renderer}`;
  if (/swiftshader|llvmpipe|softpipe|software/i.test(label)) return "software";
  if (/apple/i.test(label)) return "apple";
  if (
    /iris|uhd|hd graphics|intel|radeon\(tm\) graphics|radeon graphics|vega \d|mali|adreno|powervr/i.test(label)
  ) {
    return "integrated";
  }
  if (/nvidia|geforce|quadro|rtx|amd|radeon/i.test(label)) return "discrete";
  return "unknown";
}

function browserName(userAgent: string): string {
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  if (edge) return `Edge ${edge[1]}`;
  const chrome = /(?:Chrome|CriOS)\/([\d.]+)/.exec(userAgent);
  if (chrome) return `Chrome ${chrome[1]}`;
  const firefox = /(?:Firefox|FxiOS)\/([\d.]+)/.exec(userAgent);
  if (firefox) return `Firefox ${firefox[1]}`;
  const safari = /Version\/([\d.]+).*Safari/.exec(userAgent);
  if (safari) return `Safari ${safari[1]}`;
  return "Unknown browser";
}

export function renderingBenchmarkKey(manifestUrl: string): string {
  try {
    const url = new URL(manifestUrl, "https://simforge.invalid");
    return `${url.host === "simforge.invalid" ? "" : url.host}${url.pathname}`;
  } catch {
    return manifestUrl.split("?", 1)[0] ?? manifestUrl;
  }
}

export function renderingBenchmarkAssetBase(
  manifestUrl: string,
  documentUrl = globalThis.location?.href ?? "http://localhost/",
): string {
  return new URL(".", new URL(manifestUrl, documentUrl)).toString();
}

export function loadRenderingBenchmark(
  manifestUrl: string,
  storage?: Pick<Storage, "getItem"> | null,
): RenderingBenchmarkSnapshot | null {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    const raw = browserStorage?.getItem(RENDERING_BENCHMARK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RenderingBenchmarkSnapshot>;
    if (
      parsed.manifestUrl !== renderingBenchmarkKey(manifestUrl) ||
      !parsed.recommended ||
      !SCENARIO_AUTHORING_QUALITY_IDS.includes(parsed.recommended) ||
      !Array.isArray(parsed.results) ||
      !Array.isArray(parsed.failures) ||
      !parsed.hardware ||
      !parsed.configuration ||
      JSON.stringify(parsed.configuration) !== JSON.stringify(RENDERING_BENCHMARK_CONFIGURATION) ||
      typeof parsed.capturedAt !== "string"
    ) {
      return null;
    }
    return parsed as RenderingBenchmarkSnapshot;
  } catch {
    return null;
  }
}

export async function waitForViewerSettled(
  viewer: CityViewer,
  options: {
    timeoutMs?: number;
    stableMs?: number;
    signal?: AbortSignal;
    allowUsableOnTimeout?: boolean;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const stableMs = options.stableMs ?? 500;
  const started = performance.now();
  let stableSince: number | null = null;

  while (performance.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const stats = viewer.getStats();
    if (stats.streamingError) throw new Error(stats.streamingError);
    const idle = stats.loading === 0 && stats.queued === 0 && stats.uploading === 0;
    stableSince = idle ? (stableSince ?? performance.now()) : null;
    if (stableSince !== null && performance.now() - stableSince >= stableMs) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const stats = viewer.getStats();
  // Large production maps can keep refining off-screen/background tiles well
  // past the benchmark's load window. Once the essential road surface is
  // usable, measure that real streaming workload instead of rejecting every
  // renderer merely because optional refinement is still in flight.
  if (options.allowUsableOnTimeout && stats.roadVisible && !stats.streamingError) {
    return false;
  }
  throw new Error(
    `Map streaming did not settle within ${timeoutMs} ms `
      + `(loading ${stats.loading}, queued ${stats.queued}, uploading ${stats.uploading}).`,
  );
}
