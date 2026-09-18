import type { Object3D } from 'three';

/** Stable semantic marker used by editor renderers for helpers low-fidelity views omit. */
export const LOW_FIDELITY_HIDDEN_ROLE = 'low-fidelity-hidden';

export function isLowFidelityHiddenHelper(object: Object3D): boolean {
  return object.userData.simforgeRole === LOW_FIDELITY_HIDDEN_ROLE;
}
