import { Box3, Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { cameraEnvelopeFromBounds, constrainCameraToEnvelope, initialEditorCameraPose, initialEditorFocus } from './camera-envelope';

const scene = new Box3(new Vector3(-100, -2, -80), new Vector3(120, 35, 90));

describe('editor camera envelope', () => {
  it('spawns near the neighborhood and only modestly above local buildings', () => {
    const pose = initialEditorCameraPose(new Vector3(10, 4, 5), new Vector3(220, 37, 170), 1, 31, 41);
    expect(pose.position.y).toBe(36);
    expect(pose.position.y).toBeLessThanOrEqual(41);
    expect(pose.target.y).toBe(2.5);
    expect(pose.position.distanceTo(pose.target)).toBeLessThan(150);
  });

  it('frames authored city content when terrain centers fall outside every city tile', () => {
    const terrain = new Box3(new Vector3(-5000, 0, -5000), new Vector3(5000, 100, 5000));
    const city = new Box3(new Vector3(1980, 0, 1980), new Vector3(2020, 10, 2020));
    const focus = initialEditorFocus(terrain.getCenter(new Vector3()), [
      { bounds: { min: [3980, 0, 3980], max: [4020, 10, 4020] } },
      { bounds: { min: city.min.toArray(), max: city.max.toArray() } },
    ]);
    const pose = initialEditorCameraPose(focus, terrain.getSize(new Vector3()), 0, 10, 100);
    const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.copy(pose.position);
    camera.lookAt(pose.target);
    camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    expect(city.containsPoint(pose.target)).toBe(true);
    expect(frustum.intersectsBox(city)).toBe(true);
  });

  it('keeps road-only maps centered when they publish no city tiles', () => {
    const center = scene.getCenter(new Vector3());
    expect(initialEditorFocus(center, []).toArray()).toEqual(center.toArray());
  });

  it('hard-clamps eye and target inside the inset map footprint and altitude range', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(500, 300, -500);
    const target = new Vector3(400, -50, -300);
    const envelope = cameraEnvelopeFromBounds(scene, 2, 1, 45);
    const flags = constrainCameraToEnvelope(camera, target, envelope);
    expect(target.toArray()).toEqual([118, 1, -78]);
    expect(camera.position.toArray()).toEqual([118, 45, -78]);
    expect(flags).toEqual({ eyeX: true, eyeY: true, eyeZ: true, targetX: true, targetY: true, targetZ: true });
  });

  it('translates the eye with an overflowing target before clamping', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(110, 20, 30);
    const target = new Vector3(130, 2, 20);
    const envelope = cameraEnvelopeFromBounds(scene, 2, 1, 45);
    constrainCameraToEnvelope(camera, target, envelope);
    expect(target.x).toBe(118);
    expect(camera.position.x).toBe(98);
  });

  it('does not round an already-valid eye while constraining a rotating target', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(10.123456789012345, 20.123456789012345, -30.123456789012345);
    const target = new Vector3(40.98765432109876, 2, 20.98765432109876);
    const eye = camera.position.toArray();
    constrainCameraToEnvelope(camera, target, cameraEnvelopeFromBounds(scene, 2, 1, 45));
    expect(camera.position.toArray()).toEqual(eye);
  });

  it('recovers safely from non-finite imported camera values', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    const target = new Vector3(Number.NaN, Number.NEGATIVE_INFINITY, Number.NaN);
    const envelope = cameraEnvelopeFromBounds(scene, 2, 1, 45);
    constrainCameraToEnvelope(camera, target, envelope);
    expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
    expect(target.toArray().every(Number.isFinite)).toBe(true);
  });
});
