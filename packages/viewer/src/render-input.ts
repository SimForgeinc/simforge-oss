import type { CityManifest, MapTextureTier } from './types';
import type { Mesh, Object3D } from 'three';

/** Invalid authored input is never silently clamped or replaced. */
export class ViewerInputError extends Error {
  readonly code = 'viewer_input_invalid';
  constructor(readonly field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = 'ViewerInputError';
  }
}

export function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new ViewerInputError(field, 'expected a finite positive value');
}

export function requireTextureTier(value: MapTextureTier): void {
  if (!['low', 'medium', 'render', 'ml'].includes(value)) {
    throw new ViewerInputError('mapTextureTier', 'expected low, medium, render or ml');
  }
}

export function requireMapReference(value: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ViewerInputError('map', 'a nonblank manifest URL is required; map identity cannot be defaulted');
  }
}

/** Admit only geometry consumed by the viewer: road static layer or city tiles. */
export function requireRenderableManifest(manifest: CityManifest): void {
  if (!manifest || typeof manifest !== 'object' || !manifest.scene || !Array.isArray(manifest.tiles)) {
    throw new ViewerInputError('map.manifest', 'expected scene metadata and a tiles array');
  }
  const bounds = manifest.scene.bounds;
  if (!bounds || ![bounds.min, bounds.max].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
    || bounds.max.some((v, i) => v < bounds.min[i]!)
    || bounds.max[0] === bounds.min[0] || bounds.max[2] === bounds.min[2]) {
    throw new ViewerInputError('map.bounds', 'expected finite nonempty horizontal bounds');
  }
  if (manifest.staticLayers !== undefined && !Array.isArray(manifest.staticLayers)) {
    throw new ViewerInputError('map.members', 'expected a staticLayers array');
  }
  const road = manifest.staticLayers?.find(layer => layer?.id === 'road');
  if (!road && manifest.tiles.length === 0) throw new ViewerInputError('map.members', 'no renderable road or city members');
  const members = [...(road ? [road] : []), ...manifest.tiles.flatMap(tile => {
    if (!tile || !Array.isArray(tile.lods) || tile.lods.length === 0) throw new ViewerInputError('map.members', 'no renderable LODs');
    return tile.lods;
  })];
  for (const member of members) {
    if (!member || typeof member.file !== 'string' || !member.file.trim()) throw new ViewerInputError('map.members', 'blank geometry file');
    requirePositive(member.triangles, `map.members.${member.file}.triangles`);
  }
  const direction = manifest.shadowLightmap?.sunDirection;
  if (direction !== undefined && (!Array.isArray(direction) || direction.length !== 3
    || !direction.every(Number.isFinite) || Math.hypot(...direction) === 0)) {
    throw new ViewerInputError('map.sunDirection', 'expected a finite nonzero three-component direction');
  }
}

/** A valid manifest cannot vouch for an empty decoded GLB. */
export function requireRenderableGeometry(root: Object3D, file: string): void {
  let renderable = false;
  root.traverseVisible(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || renderable) return;
    const position = mesh.geometry.getAttribute('position');
    const count = mesh.geometry.index?.count ?? position?.count ?? 0;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (position && position.count >= 3 && Math.min(count, mesh.geometry.drawRange.count) >= 3
      && materials.some(material => material.visible && (!material.transparent || material.opacity > 0))) renderable = true;
  });
  if (!renderable) throw new ViewerInputError(`map.members.${file}`, 'decoded asset contains no visible triangle geometry');
}
