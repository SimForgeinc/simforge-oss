// The camera path the ten-map interactive benchmark drives, and the viewport
// flags it drives it with.
//
// Shared rather than duplicated because the memory census has to reproduce
// the conditions the benchmark's `gpuProcessBytes` table was measured under.
// A census taken with the camera sitting still explains a different number
// than the one in the table: standing still never admits the far side of the
// map, never evicts, and never exercises the allocator churn that the driver
// figure is mostly made of.

/**
 * Overview, four orbit stations, then a street-level pose, derived from the
 * scene bounds the manifest publishes.
 */
export function cameraPath(bounds) {
  const centre = [0, 1, 2].map((axis) => (bounds.min[axis] + bounds.max[axis]) / 2);
  const size = [0, 1, 2].map((axis) => bounds.max[axis] - bounds.min[axis]);
  const footprint = Math.max(size[0], size[2]);
  const radius = footprint * 0.6;
  const height = centre[1] + footprint * 0.35;
  const look = [centre[0], centre[1], centre[2]];
  const poses = [
    { name: 'overview', position: [centre[0], height * 1.25, centre[2] + radius * 1.25], target: look },
  ];
  for (const [name, degrees] of [['orbit-n', 0], ['orbit-e', 90], ['orbit-s', 180], ['orbit-w', 270]]) {
    const radians = (degrees * Math.PI) / 180;
    poses.push({
      name,
      position: [centre[0] + Math.cos(radians) * radius, height * 0.5, centre[2] + Math.sin(radians) * radius],
      target: look,
    });
  }
  poses.push({
    name: 'street',
    position: [centre[0], bounds.min[1] + Math.max(3, size[1] * 0.12), centre[2] + footprint * 0.12],
    target: [centre[0] + footprint * 0.3, bounds.min[1] + Math.max(2, size[1] * 0.08), centre[2]],
  });
  return poses;
}

/**
 * Viewport flags the benchmark launches with. `immediate` is load-bearing for
 * memory as well as for frame time: an uncapped present rate keeps more
 * frames, and more transient allocations, in flight.
 */
export const BENCH_VIEWPORT_ARGS = ['--frame-stats', '--present-mode', 'immediate'];

/** Milliseconds the benchmark dwells at each pose. */
export const BENCH_DWELL_MS = 2000;
