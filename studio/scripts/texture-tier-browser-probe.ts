import { Box3, DoubleSide, Matrix3, Raycaster, Triangle, Vector2, Vector3, type Mesh, type Material, type Texture } from 'three';
import type { CityViewerStats, CameraDiagnostics } from '../../packages/viewer/src/types';
import type { CityViewer } from '../../packages/viewer/src/viewer';
import type {} from '../../packages/viewer/src/viewer-diagnostics';
import type { ResidentTexture } from './texture-tier-assertions';

// Bundled separately and injected before navigation. Nothing here substitutes
// the viewer or its fetch path; all observations refer to its real scene.
export interface BrowserTierEvidence {
  readyAtMs: number;
  snapshotAtMs: number;
  stats: CityViewerStats;
  camera: CameraDiagnostics;
  pixels: { samples: number; colors: number; geometryHits: number; litGeometrySamples: number; insideFacingHits: number; centerDistance: number; nearestSurfaceM: number; trianglesExamined: number };
  glError: number;
  width: number;
  textures: ResidentTexture[];
  viable: boolean | null;
  height: number;
  visible: boolean;
}

declare global {
  interface Window {
    __tierEvidence?: BrowserTierEvidence;
    __tierProbeError?: string;
  }
}

function capture(viewer: CityViewer) {
  const canvas = viewer.renderer.domElement;
  let visible = canvas.isConnected && canvas.width > 0 && canvas.height > 0 && canvas.getBoundingClientRect().height > 0;
  for (let element: HTMLElement | null = canvas; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false;
  }
  // Read in the same task as the draw, before the default framebuffer clears.
  viewer.renderer.render(viewer.scene, viewer.camera);
  const pixel = document.createElement('canvas');
  pixel.width = pixel.height = 1;
  const context = pixel.getContext('2d', { willReadFrequently: true })!;
  const pixels: number[][] = [];
  const geometryPixels: number[][] = [];
  const ray = new Raycaster();
  const uv = new Vector2();
  const groups = [viewer.roadGroup, viewer.cityGroup];
  const textures = new Map<object, ResidentTexture>();
  const materials = new Map<Material, Material['side']>();
  for (const group of [...groups, viewer.vegetationGroup]) group.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) {
        if (!value || typeof value !== 'object' || !('isTexture' in value)) continue;
        const texture = value as Texture;
        const metadata = texture.userData.mapTexture as ResidentTexture | undefined;
        if (!metadata) continue;
        // Observe the resident image, not a URL suffix or requested allocation.
        const image = texture.image as { width: number; height: number };
        textures.set(texture.source, { ...metadata, width: image.width, height: image.height });
      }
      if (!materials.has(material)) materials.set(material, material.side);
      material.side = DoubleSide;
    }
  });
  let insideFacingHits = 0;
  let geometryHits = 0;
  const normal = new Vector3();
  const normalMatrix = new Matrix3();
  let centerDistance = Infinity;
  try {
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
      const sx = (x + 0.5) / 16;
      const sy = (y + 0.5) / 12;
      context.clearRect(0, 0, 1, 1);
      context.drawImage(canvas, Math.floor(sx * canvas.width), Math.floor(sy * canvas.height), 1, 1, 0, 0, 1, 1);
      const rgba = [...context.getImageData(0, 0, 1, 1).data];
      pixels.push(rgba);
      uv.set(sx * 2 - 1, 1 - sy * 2);
      ray.setFromCamera(uv, viewer.camera);
      const hit = ray.intersectObjects(groups, true)[0];
      if (hit) {
        geometryHits++;
        geometryPixels.push(rgba);
        if (hit.face) {
          normal.copy(hit.face.normal).applyMatrix3(normalMatrix.getNormalMatrix(hit.object.matrixWorld)).normalize();
          if (normal.dot(ray.ray.direction) > 0) insideFacingHits++;
        }
        if (x >= 6 && x <= 9 && y >= 4 && y <= 7) centerDistance = Math.min(centerDistance, hit.distance);
      }
    }
  } finally {
    for (const [material, side] of materials) material.side = side;
  }
  // Exact nearest triangle distance, not a camera-height heuristic (walls can
  // surround an eye well above ground). AABB pruning avoids distant geometry.
  let nearestSurfaceM = Infinity;
  let trianglesExamined = 0;
  const box = new Box3();
  const triangle = new Triangle();
  const closest = new Vector3();
  for (const group of groups) group.traverseVisible(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || 'isInstancedMesh' in mesh) return;
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    box.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    if (box.distanceToPoint(viewer.camera.position) >= nearestSurfaceM) return;
    const positions = geometry.getAttribute('position');
    if (!positions) return;
    const indices = geometry.index;
    const end = indices?.count ?? positions.count;
    for (let index = 0; index + 2 < end; index += 3) {
      triangle.a.fromBufferAttribute(positions, indices ? indices.getX(index) : index).applyMatrix4(mesh.matrixWorld);
      triangle.b.fromBufferAttribute(positions, indices ? indices.getX(index + 1) : index + 1).applyMatrix4(mesh.matrixWorld);
      triangle.c.fromBufferAttribute(positions, indices ? indices.getX(index + 2) : index + 2).applyMatrix4(mesh.matrixWorld);
      triangle.closestPointToPoint(viewer.camera.position, closest);
      nearestSurfaceM = Math.min(nearestSurfaceM, closest.distanceTo(viewer.camera.position));
      trianglesExamined++;
    }
  });
  const litGeometrySamples = geometryPixels.filter(([r, g, b, a]) => a! >= 250 && Math.max(r!, g!, b!) > 20).length;
  const colors = new Set(pixels.map(pixel => pixel.slice(0, 3).map(channel => channel >> 3).join(','))).size;
  const probe = window.__simforgeViewerProbe;
  const viable = probe && 'viable' in probe && typeof probe.viable === 'boolean' ? probe.viable : null;
  return { stats: viewer.getStats(), camera: viewer.getCameraDiagnostics(), textures: [...textures.values()], viable, visible,
    pixels: { samples: pixels.length, colors, geometryHits, litGeometrySamples, insideFacingHits, centerDistance, nearestSurfaceM, trianglesExamined },
    glError: viewer.renderer.getContext().getError(), width: canvas.width, height: canvas.height };
}

const watch = () => {
  try {
    const probe = window.__simforgeViewerProbe;
    const host = document.querySelector('[data-testid="scenario-world-host"]');
    if (probe?.readyAtMs != null && (!('viable' in probe) || probe.viable === true)
      && host?.getAttribute('data-world-load-percent') === '100'
      && host.getAttribute('data-world-loaded-map-version-id')) {
      const snapshotAtMs = performance.now();
      window.__tierEvidence = { ...capture(probe.viewer), readyAtMs: probe.readyAtMs, snapshotAtMs };
      return;
    }
  } catch (error) { window.__tierProbeError = String(error); return; }
  requestAnimationFrame(watch);
};
requestAnimationFrame(watch);
