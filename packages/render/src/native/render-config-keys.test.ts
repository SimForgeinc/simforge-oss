import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RENDER_CONFIG_KEYS, RENDER_CONFIG_PRESET_BASELINE, renderConfigIssues, type RenderConfigKeySpec } from './render-config-keys.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderCore = path.resolve(here, '../../../../renderer/render-core/src');
const rust = ['render_config.rs', 'profiles.rs'].map((file) => readFileSync(path.join(renderCore, file), 'utf8')).join('\n');

const camel = (snake: string) => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const kebab = (pascal: string) => pascal.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(); // serde's kebab-case: split before an uppercase letter only

/** `pub struct Name { pub field: Type, ... }` -> [[field, Type]]. */
function structFields(name: string): Array<[string, string]> | null {
  const body = rust.match(new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/^\s*pub (\w+): ([\w:]+),/gm)].map((m) => [m[1]!, m[2]!]);
}

/** A unit enum's serde wire names (`rename_all = "kebab-case"` plus explicit renames). */
function enumValues(name: string): string[] | null {
  const body = rust.match(new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (body === undefined) return null;
  const values: string[] = [];
  let rename: string | null = null;
  for (const line of body.split('\n').map((l) => l.trim())) {
    const renamed = line.match(/^#\[serde\(rename = "([^"]+)"\)\]/);
    if (renamed) rename = renamed[1]!;
    const variant = line.match(/^([A-Z]\w*),$/);
    if (variant) {
      values.push(rename ?? kebab(variant[1]!));
      rename = null;
    }
  }
  return values;
}

/** Every dotted key `RenderConfig::keys()` lists, with the spec its Rust type implies. */
function rustKeys(): Map<string, RenderConfigKeySpec['kind'] | { enum: string[] }> {
  const out = new Map<string, RenderConfigKeySpec['kind'] | { enum: string[] }>();
  const walk = (prefix: string, type: string) => {
    if (type === 'RgbOutput') return void out.set(prefix, 'rgb-output');
    if (type === 'bool') return void out.set(prefix, 'boolean');
    if (/^[ui]\d+$/.test(type)) return void out.set(prefix, 'integer');
    if (/^f\d+$/.test(type)) return void out.set(prefix, 'number');
    const fields = structFields(type);
    if (fields) {
      for (const [field, fieldType] of fields) walk(prefix ? `${prefix}.${camel(field)}` : camel(field), fieldType);
      return;
    }
    const values = enumValues(type);
    if (!values) throw new Error(`render_config.rs type ${type} at ${prefix} is neither a struct, an enum nor a primitive`);
    out.set(prefix, { enum: values });
  };
  walk('', 'RenderConfig');
  out.delete('preset'); // provenance; `set.preset` is refused, the preset is `preset`
  return out;
}

describe('RENDER_CONFIG_KEYS mirrors render_core::render_config', () => {
  it('lists exactly the keys RenderConfig serializes, each with its value kind and enum values', () => {
    const rustSide = rustKeys();
    expect(Object.keys(RENDER_CONFIG_KEYS).sort()).toEqual([...rustSide.keys()].sort());
    for (const [key, kind] of rustSide) {
      const spec = RENDER_CONFIG_KEYS[key]!;
      if (typeof kind === 'object') {
        expect(spec.kind, key).toBe('enum');
        expect(spec.kind === 'enum' ? [...spec.values].sort() : null, key).toEqual([...kind.enum].sort());
      } else {
        expect(spec.kind, key).toBe(kind);
      }
    }
  });

  it('pins the preset values the cross-key rules assume', () => {
    const preset = rust.match(/pub fn preset\(preset: Preset\) -> Self \{([\s\S]*?)\n {4}\}/)?.[1] ?? '';
    expect(preset).toContain(`tone_map: ToneMap::${RENDER_CONFIG_PRESET_BASELINE.toneMap === 'dashcam-wdr' ? 'DashcamWdr' : '?'}`);
    expect(preset).toMatch(/min_shutter_s: 1\.0 \/ 32000\.0/);
    expect(preset).toMatch(/max_shutter_s: 1\.0 \/ 30\.0/);
    expect(RENDER_CONFIG_PRESET_BASELINE.shutterS).toEqual({ min: 1 / 32_000, max: 1 / 30 });
    // Training overrides only quality knobs: grading and camera come from the shared base.
    const training = preset.match(/Preset::Training => Self \{([\s\S]*?)\.\.base/)?.[1] ?? '';
    expect(training).not.toMatch(/grading:|camera:/);
  });
});

describe('renderConfigIssues', () => {
  it('accepts either preset, no overrides, and valid overrides', () => {
    expect(renderConfigIssues({})).toEqual([]);
    expect(renderConfigIssues({ preset: 'training' })).toEqual([]);
    expect(renderConfigIssues({
      preset: 'showcase',
      set: { 'shadows.cascades': 2, 'aa.mode': 'fxaa', 'output.rgb': { format: 'png' }, 'ssr.enabled': false, 'lod.pixelErrorPx': 4 },
    })).toEqual([]);
  });

  it('refuses an unknown preset, key or value with the renderer error codes', () => {
    expect(renderConfigIssues({ preset: 'cinematic' })).toEqual([
      expect.objectContaining({ code: 'native_render_preset_unknown', key: 'preset' }),
    ]);
    // The renderer's own unit-test cases (render_config.rs overrides_apply_and_unknown_keys_fail).
    for (const key of ['shadows.cascadez', 'nope', 'shadows.cascades.x']) {
      expect(renderConfigIssues({ set: { [key]: 1 } })).toEqual([
        expect.objectContaining({ code: 'native_render_config_unknown_key', key }),
      ]);
    }
    for (const [key, value] of [['shadows.cascades', 9], ['aa.mode', 'msaa'], ['shadows.cascades', 'two'], ['lod.pixelErrorPx', 0]] as const) {
      expect(renderConfigIssues({ set: { [key]: value } })).toEqual([
        expect.objectContaining({ code: 'native_render_config_invalid', key }),
      ]);
    }
    expect(renderConfigIssues({ set: { 'shadows.mapSize': 2560 } })[0]?.message).toContain('power of two');
    expect(renderConfigIssues({ set: { preset: 'training' } })[0]?.message).toContain('`preset`');
  });

  it('applies the cross-key rules against the preset values', () => {
    expect(renderConfigIssues({ set: { 'grading.temperature': 0.2 } })[0]?.code).toBe('native_render_config_invalid');
    expect(renderConfigIssues({ set: { 'grading.temperature': 0.2, 'grading.toneMap': 'agx' } })).toEqual([]);
    expect(renderConfigIssues({ set: { 'camera.sensor.minShutterS': 0.5 } })[0]?.key).toBe('camera.sensor.minShutterS');
  });
});
