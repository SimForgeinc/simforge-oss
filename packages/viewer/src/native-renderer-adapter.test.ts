import { describe, expect, it } from 'vitest';
import { chooseRendererMode } from './native-renderer-adapter';

describe('renderer selection contract', () => {
  it('keeps explicit web mode on WebGL', () => expect(chooseRendererMode('web', true)).toBe('web'));
  it('selects native in auto mode when available', () => expect(chooseRendererMode('auto', true)).toBe('native'));
  it('falls back to web in auto mode when native is unavailable', () => expect(chooseRendererMode('auto', false)).toBe('web'));
  it('fails explicit native mode when unavailable', () => expect(() => chooseRendererMode('native', false)).toThrow(/unavailable/));
});
