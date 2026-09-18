import { Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { isLowFidelityHiddenHelper, LOW_FIDELITY_HIDDEN_ROLE } from './low-fidelity';

describe('low-fidelity helper classification', () => {
  it('recognizes only explicitly tagged editor helpers', () => {
    const helper = new Object3D();
    helper.userData.simforgeRole = LOW_FIDELITY_HIDDEN_ROLE;
    expect(isLowFidelityHiddenHelper(helper)).toBe(true);
    expect(isLowFidelityHiddenHelper(new Object3D())).toBe(false);
  });
});
