import { RENDER_PRESETS, type RenderPreset } from '@simforge-oss/scenario';

/**
 * The native renderer's `RenderConfig` keys, as a render request's `set` names
 * them (`render_core::render_config`), with the values each one accepts.
 *
 * It lets a control plane refuse an unknown key or an invalid value when a job
 * is submitted, with the renderer's own words, instead of leasing a job that
 * the worker would then fail. The renderer stays the authority: it resolves
 * and validates the request again (`RenderRequest::resolve`) and records the
 * resolved config in the manifest.
 *
 * Mirrors `RenderConfig::keys()` and `RenderConfig::validate()` (plus
 * `CinematicFx::validate()`). `render-config-keys.test.ts` reads the Rust
 * source and fails when a key or an enum value is added, renamed or removed
 * there, so the two cannot drift silently.
 */
export type RenderConfigKeySpec =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number; readonly powerOfTwo?: true }
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly exclusiveMin?: number }
  | { readonly kind: 'rgb-output' };

const bool = { kind: 'boolean' } as const;
const oneOf = (...values: string[]) => ({ kind: 'enum', values }) as const;
const int = (min: number, max: number) => ({ kind: 'integer', min, max }) as const;
const num = (bounds: { min?: number; max?: number; exclusiveMin?: number } = {}) => ({ kind: 'number', ...bounds }) as const;
const U32_MAX = 4_294_967_295;

export const RENDER_CONFIG_KEYS: Readonly<Record<string, RenderConfigKeySpec>> = {
  'aa.mode': oneOf('off', 'fxaa', 'smaa-low', 'smaa-medium', 'smaa-high', 'smaa-ultra', 'taa'),
  'aa.taaSamples': int(1, 16),
  'shadows.mapSize': { kind: 'integer', min: 512, max: 8192, powerOfTwo: true },
  'shadows.cascades': int(1, 4),
  'shadows.maxDistanceM': num({ min: 10 }),
  'shadows.shared': bool,
  'ssao.enabled': bool,
  'ssao.quality': oneOf('low', 'medium', 'high', 'ultra'),
  'ssao.contactShadows': bool,
  'ssao.contactShadowSteps': int(1, 64),
  'ssr.enabled': bool,
  'ssr.linearSteps': int(1, 64),
  'ssr.bisectionSteps': int(0, 16),
  'bloom.intensity': num({ min: 0 }),
  'dof.enabled': bool,
  'dof.apertureFStops': num({ exclusiveMin: 0 }),
  'dof.focalDistanceM': num({ exclusiveMin: 0 }),
  'motionBlur.shutterAngle': num({ min: 0, max: 360 }),
  'motionBlur.samples': int(1, 32),
  'grading.toneMap': oneOf(
    'agx', 'tony-mc-mapface', 'aces-fitted', 'blender-filmic', 'reinhard', 'reinhard-luminance',
    'somewhat-boring-display-transform', 'none', 'dashcam-wdr',
  ),
  'grading.exposure': num(),
  'grading.temperature': num(),
  'grading.tint': num(),
  'grading.postSaturation': num({ min: 0 }),
  'grading.contrast': num({ exclusiveMin: 0 }),
  // A bundle over camera/grading/lens keys (`CameraProfile::KEYS`); explicit overrides of those still win.
  'camera.profile': oneOf('automotive', 'consumer-dashcam'),
  'camera.exposure.mode': oneOf('auto', 'fixed'),
  'camera.exposure.compensationEv': num({ min: -6, max: 6 }),
  'camera.exposure.metering': oneOf('average', 'center-weighted', 'dashcam'),
  'camera.exposure.trim': num({ min: 0, max: 0.45 }),
  'camera.sensor.fNumber': num({ min: 0.7, max: 32 }),
  'camera.sensor.minShutterS': num({ exclusiveMin: 0, max: 1 }),
  'camera.sensor.maxShutterS': num({ exclusiveMin: 0, max: 1 }),
  'camera.sensor.isoMax': num({ min: 100, max: 409_600 }),
  'camera.wdr.whiteStops': num({ min: 2, max: 12 }),
  'camera.wdr.midGrey': num({ min: 0.05, max: 0.5 }),
  'atmosphere.hazeDensity': num({ min: 0, max: 20 }),
  'lighting.canopySkyOcclusion': bool,
  'lens.vignette': num({ min: 0 }),
  'lens.distortion': num(),
  'lens.chromaticAberration': num(),
  'lod.enabled': bool,
  'lod.pixelErrorPx': num({ min: 0.25, max: 16 }),
  'textures.tier': oneOf('uastc-full', 'bc7-512'),
  'lidar.backend': oneOf('auto', 'gpu', 'cpu', 'verify'),
  'output.rgb': { kind: 'rgb-output' },
  'output.video.codec': oneOf('h264', 'hevc'),
  'output.video.quality': int(0, 51),
  'encode.finishThreads': int(0, 64),
  'clock.mode': oneOf('pinned', 'free'),
};

/**
 * The preset values the cross-key rules below read when a request does not
 * override them. Both presets share them (`RenderConfig::preset`); the Rust
 * source test pins these literals too.
 */
const PRESET_TONE_MAP = 'dashcam-wdr';
const PRESET_SHUTTER_S = { min: 1 / 32_000, max: 1 / 30 } as const;

/** One refused `set` entry, in the renderer's own error vocabulary. */
export interface RenderConfigIssue {
  readonly code: 'native_render_preset_unknown' | 'native_render_config_unknown_key' | 'native_render_config_invalid';
  /** `preset`, or the `set` key the issue is about. */
  readonly key: string;
  readonly message: string;
}

export function isRenderPreset(value: unknown): value is RenderPreset {
  return typeof value === 'string' && (RENDER_PRESETS as readonly string[]).includes(value);
}

function describe(spec: RenderConfigKeySpec): string {
  switch (spec.kind) {
    case 'boolean': return 'true or false';
    case 'enum': return spec.values.join(' | ');
    case 'integer': return `an integer in ${spec.min}..=${spec.max}${spec.powerOfTwo ? ', a power of two' : ''}`;
    case 'rgb-output': return '{"format":"png"} or {"format":"jpeg","quality":1..=100}';
    case 'number': {
      const low = spec.exclusiveMin !== undefined ? `> ${spec.exclusiveMin}` : spec.min !== undefined ? `>= ${spec.min}` : null;
      const high = spec.max !== undefined ? `<= ${spec.max}` : null;
      return ['a finite number', low, high].filter(Boolean).join(', ');
    }
  }
}

function valueFits(spec: RenderConfigKeySpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && spec.values.includes(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max
        && (!spec.powerOfTwo || (value & (value - 1)) === 0);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && (spec.min === undefined || value >= spec.min)
        && (spec.max === undefined || value <= spec.max)
        && (spec.exclusiveMin === undefined || value > spec.exclusiveMin);
    case 'rgb-output': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const { format, quality, ...rest } = value as Record<string, unknown>;
      if (Object.keys(rest).length > 0) return false;
      if (format === 'png') return quality === undefined;
      return format === 'jpeg' && typeof quality === 'number' && Number.isInteger(quality) && quality >= 1 && quality <= 100;
    }
  }
}

/**
 * Checks a render request the way `RenderRequest::resolve` would: the preset
 * is one of the two, every `set` key is a `RenderConfig` key, every value fits
 * its key, and the cross-key rules hold against the preset's values. Returns
 * every issue (empty when the request is valid); never corrects anything.
 */
export function renderConfigIssues(request: { preset?: unknown; set?: Readonly<Record<string, unknown>> }): RenderConfigIssue[] {
  const issues: RenderConfigIssue[] = [];
  if (request.preset !== undefined && !isRenderPreset(request.preset)) {
    issues.push({ code: 'native_render_preset_unknown', key: 'preset', message: `preset ${JSON.stringify(request.preset)} is not a render preset (${RENDER_PRESETS.join(' | ')})` });
  }
  const set = request.set ?? {};
  for (const [key, value] of Object.entries(set)) {
    if (key === 'preset') {
      issues.push({ code: 'native_render_config_invalid', key, message: 'set the preset with `preset`, not `set.preset`' });
      continue;
    }
    const spec = RENDER_CONFIG_KEYS[key];
    if (!spec) {
      issues.push({ code: 'native_render_config_unknown_key', key, message: `${JSON.stringify(key)} is not a render config key` });
      continue;
    }
    if (!valueFits(spec, value)) {
      issues.push({ code: 'native_render_config_invalid', key, message: `${key} ${JSON.stringify(value)} is invalid (${describe(spec)})` });
    }
  }
  if (issues.length > 0) return issues;
  const toneMap = set['grading.toneMap'] ?? PRESET_TONE_MAP;
  if (toneMap === 'dashcam-wdr' && ((set['grading.temperature'] ?? 0) !== 0 || (set['grading.tint'] ?? 0) !== 0)) {
    issues.push({
      code: 'native_render_config_invalid',
      key: set['grading.temperature'] !== undefined ? 'grading.temperature' : 'grading.tint',
      message: 'grading.temperature/tint are not applied by the dashcam-wdr camera model; use another grading.toneMap or leave them 0',
    });
  }
  const minShutter = (set['camera.sensor.minShutterS'] as number | undefined) ?? PRESET_SHUTTER_S.min;
  const maxShutter = (set['camera.sensor.maxShutterS'] as number | undefined) ?? PRESET_SHUTTER_S.max;
  if (!(minShutter < maxShutter)) {
    issues.push({
      code: 'native_render_config_invalid',
      key: set['camera.sensor.minShutterS'] !== undefined ? 'camera.sensor.minShutterS' : 'camera.sensor.maxShutterS',
      message: `camera.sensor.minShutterS ${minShutter} must be below camera.sensor.maxShutterS ${maxShutter}`,
    });
  }
  return issues;
}

/** For tests: the literals the cross-key rules assume the presets carry. */
export const RENDER_CONFIG_PRESET_BASELINE = { toneMap: PRESET_TONE_MAP, shutterS: PRESET_SHUTTER_S } as const;
