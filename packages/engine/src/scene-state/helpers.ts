/**
 * Renderer-side helpers for simforge.scene-state.v1 documents. Emission itself is native
 * (`EngineRuntime.sceneState`); these reproduce the two conventions a consumer
 * needs to interpret a document it did not emit.
 */

/** Yaw about +Y → y-up quaternion `[x, y, z, w]`. */
export function yawToQuaternion(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

const CATALOG_BY_KIND: Record<string, string> = {
  pedestrian: 'pedestrian.adult',
  bicycle: 'cyclist.commuter',
  bus: 'vehicle.transit-bus',
  truck: 'vehicle.box-truck',
  motorcycle: 'vehicle.motorcycle',
  obstacle: 'prop.traffic-cone',
  static_object: 'hazard.cardboard_box',
};

/**
 * Catalog binding for an actor. Traces tag actors with
 * `catalog:<prop-catalog id>` when authored; otherwise a deterministic class
 * default keeps browser/native consistent.
 */
export function catalogIdFor(meta:
  | { readonly kind: string; readonly tags?: readonly string[] }
  | undefined): string {
  const tagged = meta?.tags?.find((t) => t.startsWith('catalog:'));
  if (tagged) return tagged.slice('catalog:'.length);
  return CATALOG_BY_KIND[meta?.kind ?? ''] ?? 'vehicle.sedan';
}
