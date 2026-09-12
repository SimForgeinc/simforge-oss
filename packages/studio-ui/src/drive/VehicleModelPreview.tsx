"use client";

import { useEffect, useRef } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { buildProp, getEntry, type CatalogId } from "@simforge-oss/asset-catalog";
import {
  externalModelScene,
  externalModelState,
  onExternalModelChange,
  requestExternalModel,
} from "@simforge-oss/viewer";

/** Material slot the CARLA vehicle pack exposes for the body colour. */
const PAINT_MATERIAL = "body_paint";
const TURNTABLE_RAD_PER_S = 0.35;

/**
 * A slowly turning single vehicle on a transparent background.
 *
 * Its own tiny renderer rather than a corner of the city viewer: the picker
 * runs before a world exists, and a second scene of one car costs less than
 * keeping a streaming viewer alive to show it. Falls back to the procedural
 * builder for catalog families that have no GLB yet, so the picker is never
 * blank.
 */
export function VehicleModelPreview({ catalogId, color, xstyle }: {
  catalogId: CatalogId;
  /** Hex colour applied to the paint slot; livery vehicles ignore it. */
  color: string;
  /**
   * Where the preview sits. The host owns the box because the stage it fills
   * is the caller's: the preview only needs to know it must have one, and a
   * `className` here would leave a Tailwind seam in an otherwise compiled
   * surface.
   */
  xstyle?: stylex.StyleXStyles;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<Group | null>(null);
  const colorRef = useRef(color);

  useEffect(() => {
    colorRef.current = color;
    const model = modelRef.current;
    if (!model) return;
    applyPaint(model, color);
  }, [color]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearAlpha(0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1.5));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 3);
    scene.add(key);
    const fill = new DirectionalLight(0x88aaff, 0.7);
    fill.position.set(-5, 3, -4);
    scene.add(fill);

    const camera = new PerspectiveCamera(32, 1, 0.1, 200);
    const pivot = new Group();
    scene.add(pivot);

    const frame = (): void => {
      const bounds = new Box3().setFromObject(pivot);
      if (bounds.isEmpty()) return;
      const size = bounds.getSize(new Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.5;
      const distance = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.5;
      camera.position.set(distance * 0.8, radius * 1.15 + distance * 0.28, distance * 0.75);
      camera.lookAt(0, size.y * 0.45, 0);
    };

    const attach = (model: Group): void => {
      const previous = modelRef.current;
      if (previous) {
        pivot.remove(previous);
        disposePreviewModel(previous);
      }
      modelRef.current = model;
      applyPaint(model, colorRef.current);
      pivot.add(model);
      frame();
    };
    const attachBuilt = (): void => {
      const built = buildProp(catalogId);
      built.userData.driveBuiltLocally = true;
      attach(built);
    };

    const entry = getEntry(catalogId);
    const binding = entry.model;
    let unsubscribe: (() => void) | null = null;
    if (binding?.kind === "glb") {
      const hash = binding.contentHash;
      const useLoaded = (): boolean => {
        const loaded = externalModelScene(hash);
        if (!loaded) return false;
        const clone = loaded.clone(true);
        // The cache normalises the model to sit on y=0 centred on x/z but keeps
        // its authored size; the picker shows it at catalog scale so a bus is
        // visibly a bus next to a hatchback.
        const measured = new Box3().setFromObject(clone).getSize(new Vector3());
        if (measured.x > 0) clone.scale.multiplyScalar(entry.dims.l / measured.x);
        attach(clone);
        return true;
      };
      if (!useLoaded()) {
        attachBuilt();
        if (externalModelState(hash) !== "failed") requestExternalModel(binding);
        unsubscribe = onExternalModelChange((changed) => {
          if (changed === hash) useLoaded();
        });
      }
    } else {
      attachBuilt();
    }

    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      pivot.rotation.y += TURNTABLE_RAD_PER_S * dt;
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width > 0 && height > 0) {
        renderer.setSize(width, height, false);
        if (camera.aspect !== width / height) {
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          frame();
        }
      }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe?.();
      const model = modelRef.current;
      if (model) disposePreviewModel(model);
      modelRef.current = null;
      renderer.domElement.remove();
      renderer.dispose();
    };
  }, [catalogId]);

  return <div {...stylex.props(xstyle)} data-testid="drive-vehicle-preview" ref={hostRef} />;
}

/**
 * Tint the paint slot in place.
 *
 * The GLB cache hands out one shared scene per content hash, and `clone()`
 * shares its materials, so the preview must own a copy of any material it
 * recolours or every car in the game would change colour with it. The copy is
 * marked so teardown can dispose exactly what was created here.
 */
function applyPaint(model: Group, color: string): void {
  const tint = new Color(color);
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    node.material = materials.map((material) => {
      if (!(material instanceof MeshStandardMaterial)) return material;
      const paintable = material.name === PAINT_MATERIAL || material.name === "paint";
      if (!paintable) return material;
      const owned = material.userData.drivePreviewClone === true
        ? material
        : Object.assign(material.clone(), { userData: { drivePreviewClone: true } });
      owned.color.copy(tint);
      return owned;
    });
    if (Array.isArray(node.material) && node.material.length === 1) node.material = node.material[0]!;
  });
}

/**
 * Release what this preview created: the recoloured material copies always, and
 * the whole mesh when the model came from the procedural builder. A GLB clone's
 * geometry belongs to the shared model cache and must survive.
 */
function disposePreviewModel(model: Group): void {
  const builtLocally = model.userData.driveBuiltLocally === true;
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (builtLocally || (material instanceof MeshStandardMaterial && material.userData.drivePreviewClone === true)) {
        material.dispose();
      }
    }
    if (builtLocally) node.geometry.dispose();
  });
}
