/**
 * Map underlay for the deterministic trace renderer package.
 *
 * Pure functions from a parsed `topology-index.json.gz` (and optionally
 * `derived/locations.json.gz`) to SVG layer strings, so a vision judge sees
 * roads instead of boxes on a grid. Lane centrelines are painted as strokes of
 * their representative width, coloured by laneType; junction internal lanes get
 * a wider surface coat underneath so junction areas read as continuous asphalt;
 * driving lanes get thin offset boundary lines; crosswalk anchors (when the
 * derived locations file exists) get zebra stripes.
 *
 * Everything here is deterministic: lanes and crosswalks are sorted by id, no
 * clock, no randomness, and the SVG text depends only on the inputs.
 */

/** Fill colours per topology laneType. Driving must read as road against #101820. */
export const LANE_STYLES = {
  driving: { fill: '#6e7987' },
  shoulder: { fill: '#3c4550' },
  parking: { fill: '#4e5a66' },
  biking: { fill: '#46685a' },
  sidewalk: { fill: '#7b7364' },
};

/** Anything the topology names that we have no dedicated style for. */
export const LANE_STYLE_FALLBACK = { fill: '#4a525c' };

/** Junction surface coat: subtle, no border, wider than the lane itself. */
export const JUNCTION_SURFACE_FILL = '#5a646f';
export const JUNCTION_SURFACE_WIDTH_FACTOR = 1.9;

export const BOUNDARY_STROKE = '#d9dee5';
export const MISALIGNED_MARKING_OFFSET_M = 0.75;

const MARKING_STYLES = {
  crisp: { opacity: '0.6', dash: null },
  faded: { opacity: '0.22', dash: '8 5' },
  obscured: { opacity: '0.15', dash: '5 4' },
  misaligned: { opacity: '0.75', dash: null },
};
export const CROSSWALK_STRIPE_FILL = '#e8ecf1';

/** Paint order: below everything else, sidewalks under driving so kerb lines stay visible. */
const NON_DRIVING_ORDER = ['shoulder', 'parking', 'sidewalk', 'biking'];

const CROSSWALK_BAND_M = 3.0; // stripe length along the lane direction
const CROSSWALK_STRIPE_M = 0.6; // stripe width across
const CROSSWALK_PITCH_M = 1.2; // stripe repeat across

const SURFACE_PATCH_STYLES = {
  ice: { color: '#7fd4e8', tag: 'ICE' },
  packed_snow: { color: '#f0f0f0', tag: 'SNOW' },
  standing_water: { color: '#4a7fc1', tag: 'WATER' },
  wet_leaves: { color: '#7a8c3f', tag: 'WET LEAVES' },
  loose_gravel: { color: '#c2a878', tag: 'GRAVEL' },
  sand: { color: '#e0cfa0', tag: 'SAND' },
  spilled_oil: { color: '#5a4a7a', tag: 'OIL' },
  polished_asphalt: { color: '#9a9a9a', tag: 'POLISHED' },
  grit_treated: { color: '#b08050', tag: 'GRIT' },
};

/**
 * Normalize a parsed topology-index document into a draw-ready model.
 * Lanes sorted by rsl; each lane carries a bbox padded by its painted
 * half-width so viewport culling is a plain rectangle test.
 */
export function underlayFromTopology(topology, locationsDoc = null, signalsDoc = null) {
  const lanes = [];
  for (const key of Object.keys(topology.lanes ?? {}).sort()) {
    const lane = topology.lanes[key];
    const pts = lane.polyline ?? [];
    if (pts.length < 2) continue;
    const widthM = Math.max(0.3, lane.representativeWidthM ?? 3.0);
    const isJunction = lane.isJunction === true;
    const pad = (widthM / 2) * (isJunction ? JUNCTION_SURFACE_WIDTH_FACTOR : 1) + 0.5;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    lanes.push({
      rsl: lane.rsl ?? key,
      laneType: lane.laneType ?? 'unknown',
      isJunction,
      widthM,
      pts,
      bbox: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad },
    });
  }
  return {
    mapName: topology.mapName ?? null,
    lanes,
    crosswalks: locationsDoc ? crosswalksFromLocations(locationsDoc) : [],
    furniture: [...(signalsDoc?.furniture ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

/**
 * Crosswalk anchors from a derived locations document. The scene frame is the
 * 3D one (x, height, z); the trace/topology world is (x, -z) — the same
 * convention `render-trace.mjs` already uses for occluder OBBs.
 */
export function crosswalksFromLocations(locationsDoc) {
  const out = [];
  for (const loc of locationsDoc.locations ?? []) {
    if (loc.type !== 'crosswalk') continue;
    const scene = loc.anchor?.scene;
    if (!scene || typeof scene.x !== 'number' || typeof scene.z !== 'number') continue;
    out.push({
      id: loc.id ?? loc.handle ?? 'crosswalk',
      x: scene.x,
      y: -scene.z,
      headingRad: loc.anchor?.road?.headingRad ?? 0,
      halfSpanM: Math.min(12, Math.max(2, loc.extent?.radiusM ?? 4)),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** World-space rectangle the camera can see, padded so wide strokes at the rim still paint. */
export function viewportBounds({ camera, scale, width, height }, marginM = 2) {
  const halfW = width / 2 / scale + marginM;
  const halfH = height / 2 / scale + marginM;
  return {
    minX: camera.x - halfW,
    maxX: camera.x + halfW,
    minY: camera.y - halfH,
    maxY: camera.y + halfH,
  };
}

/**
 * Fixed catalog props as deterministic, view-culled OBB polygons. Prop poses
 * use the scene frame (x, z), so z is inverted into trace/world y. Catalog
 * dimensions are unscaled; the uniform prop scale is applied exactly once.
 * A 6 px floor on both axes keeps small props such as traffic cones legible.
 */
export function propSvgLayer(props, view, project) {
  const bounds = viewportBounds(view, 14);
  const minWorldSize = 6 / view.scale;
  const layers = [];
  const sorted = [...(props ?? [])].sort((a, b) => (
    String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  ));

  for (const prop of sorted) {
    const center = { x: prop.pose.x, y: -prop.pose.z };
    const scale = prop.scale ?? 1;
    const lengthM = Math.max(minWorldSize, prop.dims.l * scale);
    const widthM = Math.max(minWorldSize, prop.dims.w * scale);
    const headingRad = prop.pose.headingRad;
    const f = { x: Math.cos(headingRad), y: Math.sin(headingRad) };
    const r = { x: -Math.sin(headingRad), y: Math.cos(headingRad) };
    const corners = [];
    for (const [sf, sr] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      corners.push({
        x: center.x + f.x * (lengthM / 2) * sf + r.x * (widthM / 2) * sr,
        y: center.y + f.y * (lengthM / 2) * sf + r.y * (widthM / 2) * sr,
      });
    }
    const minX = Math.min(...corners.map((p) => p.x));
    const maxX = Math.max(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y));
    const maxY = Math.max(...corners.map((p) => p.y));
    if (minX > bounds.maxX || maxX < bounds.minX || minY > bounds.maxY || maxY < bounds.minY) continue;

    const points = corners
      .map(project)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');
    layers.push(
      `<polygon class="authored-prop" points="${points}" fill="#8a8f98" fill-opacity="0.55" stroke="#5b6068" stroke-width="1"/>`,
    );
  }
  return layers;
}

function inView(lane, b) {
  return lane.bbox.minX <= b.maxX && lane.bbox.maxX >= b.minX && lane.bbox.minY <= b.maxY && lane.bbox.maxY >= b.minY;
}

/**
 * Offset a polyline perpendicular to travel: positive = left of travel
 * (+90° from segment heading), using averaged segment normals at interior
 * points. Good enough for lane boundaries at rendering scale.
 */
export function offsetPolyline(pts, offsetM) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // left normal of (dx, dy) is (-dy, dx)
    out[i] = { x: pts[i].x + (-dy / len) * offsetM, y: pts[i].y + (dx / len) * offsetM };
  }
  return out;
}

function screenPolyline(pts, project) {
  const parts = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 1) {
    const s = project(pts[i]);
    parts[i] = `${s.x.toFixed(1)},${s.y.toFixed(1)}`;
  }
  return parts.join(' ');
}

function strokeLayer(cls, pts, project, color, widthPx, opacity, dash = null) {
  return (
    `<polyline class="${cls}" points="${screenPolyline(pts, project)}" fill="none" stroke="${color}"` +
    ` stroke-width="${widthPx.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"` +
    `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  );
}

/** World-space corner list of one zebra stripe rectangle. */
function stripeCorners(cw, alongOffsetM) {
  // Band axis (walking direction) is perpendicular to the lane heading.
  const hx = Math.cos(cw.headingRad);
  const hy = Math.sin(cw.headingRad);
  const px = -hy; // band axis unit
  const py = hx;
  const cxx = cw.x + px * alongOffsetM;
  const cyy = cw.y + py * alongOffsetM;
  const halfLane = CROSSWALK_BAND_M / 2; // stripe long side, along lane heading
  const halfStripe = CROSSWALK_STRIPE_M / 2; // stripe short side, along band
  return [
    { x: cxx + hx * halfLane + px * halfStripe, y: cyy + hy * halfLane + py * halfStripe },
    { x: cxx + hx * halfLane - px * halfStripe, y: cyy + hy * halfLane - py * halfStripe },
    { x: cxx - hx * halfLane - px * halfStripe, y: cyy - hy * halfLane - py * halfStripe },
    { x: cxx - hx * halfLane + px * halfStripe, y: cyy - hy * halfLane + py * halfStripe },
  ];
}

function pointAlongPolyline(pts, targetM) {
  let walkedM = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const segmentM = Math.hypot(b.x - a.x, b.y - a.y);
    if (walkedM + segmentM >= targetM) {
      const f = segmentM > 0 ? (targetM - walkedM) / segmentM : 0;
      return { point: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, segment: i };
    }
    walkedM += segmentM;
  }
  return { point: pts[pts.length - 1], segment: pts.length - 1 };
}

function polylineLength(pts) {
  return pts.slice(1).reduce(
    (sum, point, i) => sum + Math.hypot(point.x - pts[i].x, point.y - pts[i].y),
    0,
  );
}

/** Exact longitudinal slice of a lane centreline, including interpolated ends. */
function polylineWindow(pts, sMin, sMax) {
  const lengthM = polylineLength(pts);
  const lo = Math.max(0, Math.min(lengthM, sMin));
  const hi = Math.max(lo, Math.min(lengthM, sMax));
  if (hi - lo <= 1e-6) return [];
  if (lo === 0 && hi === lengthM) return pts;
  const start = pointAlongPolyline(pts, lo);
  const end = pointAlongPolyline(pts, hi);
  const center = [start.point];
  for (let i = start.segment; i < end.segment; i += 1) center.push(pts[i]);
  center.push(end.point);
  return center;
}

function laneWindowPolygon(lane, sMin, sMax) {
  const center = polylineWindow(lane.pts, sMin, sMax);
  if (center.length < 2) return [];
  return [
    ...offsetPolyline(center, lane.widthM / 2),
    ...offsetPolyline(center, -lane.widthM / 2).reverse(),
  ];
}

function surfacePatchPolygon(patch, lanes) {
  const region = patch.region;
  if (region?.kind === 'polygon') return region.points.map((point) => ({ x: point.x, y: -point.z }));
  if (region?.kind === 'circle') {
    return Array.from({ length: 32 }, (_, i) => {
      const angle = (i / 32) * Math.PI * 2;
      return {
        x: region.center.x + Math.cos(angle) * region.radiusM,
        y: -region.center.z - Math.sin(angle) * region.radiusM,
      };
    });
  }
  if (region?.kind === 'laneWindow') {
    const lane = lanes.find((candidate) => candidate.rsl === region.rsl);
    return lane ? laneWindowPolygon(lane, region.sMin, region.sMax) : [];
  }
  return [];
}

/**
 * Render authored surface coverings from their concrete engine regions.
 * `view.lanes` is supplied by `underlaySvgLayers` to resolve lane windows.
 */
export function surfacePatchSvgLayer(patches, view, project) {
  const bounds = viewportBounds(view, 2);
  const visible = [];
  for (const patch of [...(patches ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const style = SURFACE_PATCH_STYLES[patch.kind];
    if (!style) continue;
    const points = surfacePatchPolygon(patch, view.lanes ?? []);
    if (points.length < 3) continue;
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    if (minX > bounds.maxX || maxX < bounds.minX || minY > bounds.maxY || maxY < bounds.minY) continue;
    visible.push({ patch, style, points });
  }
  if (visible.length === 0) return [];

  const kinds = [...new Set(visible.map(({ patch }) => patch.kind))].sort();
  const layers = [
    `<defs>${kinds.map((kind) => {
      const color = SURFACE_PATCH_STYLES[kind].color;
      return `<pattern id="surface-hatch-${kind}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="${color}" stroke-width="2"/></pattern>`;
    }).join('')}</defs>`,
  ];
  for (const { patch, style, points } of visible) {
    const screen = screenPolyline(points, project);
    const centroid = points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 },
    );
    const label = project(centroid);
    layers.push(
      `<polygon class="underlay-surface-patch" points="${screen}" fill="${style.color}" opacity="0.35"/>`,
      `<polygon class="underlay-surface-hatch" points="${screen}" fill="url(#surface-hatch-${patch.kind})" opacity="0.7"/>`,
      `<text class="underlay-surface-tag" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" fill="#ffffff" font-family="monospace" font-size="9" font-weight="bold" text-anchor="middle" dominant-baseline="middle">${style.tag}</text>`,
    );
  }
  return layers;
}

function screenPoints(points) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/** Static sign furniture, already normalized into the trace/topology frame. */
export function signSvgLayer(signs, view, project) {
  const bounds = viewportBounds(view, 2);
  const layers = [];
  for (const sign of signs ?? []) {
    if (sign.kind !== 'sign' || sign.x < bounds.minX || sign.x > bounds.maxX || sign.y < bounds.minY || sign.y > bounds.maxY) continue;
    const c = project(sign);
    if (sign.category === 'stop_sign') {
      const points = [];
      for (let i = 0; i < 8; i += 1) {
        const angle = -Math.PI / 8 + (i * Math.PI) / 4;
        points.push({ x: c.x + Math.cos(angle) * 7, y: c.y + Math.sin(angle) * 7 });
      }
      layers.push(`<polygon class="underlay-sign-stop" points="${screenPoints(points)}" fill="#c62828" stroke="#ffffff" stroke-width="1"/>`);
    } else if (sign.category === 'yield_sign') {
      const points = [
        { x: c.x - 7, y: c.y - 5 },
        { x: c.x + 7, y: c.y - 5 },
        { x: c.x, y: c.y + 7 },
      ];
      layers.push(`<polygon class="underlay-sign-yield" points="${screenPoints(points)}" fill="#ffffff" stroke="#c62828" stroke-width="1.5"/>`);
    } else if (sign.category === 'speed_limit_sign') {
      const limit = sign.speedLimitMph ?? (sign.speedLimitKph ? Math.round(sign.speedLimitKph / 1.609344) : null);
      layers.push(`<rect class="underlay-sign-speed" x="${(c.x - 7).toFixed(1)}" y="${(c.y - 7).toFixed(1)}" width="14" height="14" rx="2" fill="#ffffff" stroke="#555" stroke-width="1"/>`);
      if (limit !== null) {
        layers.push(`<text class="underlay-sign-speed-limit" x="${c.x.toFixed(1)}" y="${(c.y + 2.8).toFixed(1)}" fill="#000000" font-family="monospace" font-size="8" font-weight="bold" text-anchor="middle">${limit}</text>`);
      }
    } else {
      layers.push(`<rect class="underlay-sign-other" x="${(c.x - 3.5).toFixed(1)}" y="${(c.y - 3.5).toFixed(1)}" width="7" height="7" fill="#ffffff" stroke="#555" stroke-width="1"/>`);
    }
  }
  return layers;
}

function signalColor(phase) {
  if (phase === 'green' || phase === 'green_arrow' || phase === 'proceed') return '#46a758';
  if (phase === 'yellow' || phase === 'yellow_arrow' || phase === 'flashing_yellow' || phase === 'flashing_yellow_arrow') return '#f5a524';
  if (phase === 'red' || phase === 'red_x' || phase === 'stop' || phase === 'flashing_red' || phase === 'flashing_red_arrow') return '#e5484d';
  return '#3a3a3a';
}

function protectedMovementVector(program, head, lanesByRsl) {
  const connectingRsls = (program.stopLines ?? []).flatMap((line) => line.connectingLaneRsls ?? []);
  for (const rsl of connectingRsls) {
    const lane = lanesByRsl.get(rsl);
    if (!lane || lane.pts.length < 2) continue;
    const first = lane.pts[0];
    const last = lane.pts[lane.pts.length - 1];
    const firstD = Math.hypot(first.x - head.x, first.y - head.y);
    const lastD = Math.hypot(last.x - head.x, last.y - head.y);
    const from = firstD <= lastD ? first : last;
    const to = firstD <= lastD ? last : first;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length > 0.001) return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  }
  return { x: Math.cos(head.headingRad ?? 0), y: Math.sin(head.headingRad ?? 0) };
}

/**
 * Physical signal heads joined to authoritative per-tick phases solely through
 * SignalProgram.mapBinding.headIds. Flashing is a pure function of frame time.
 */
export function signalSvgLayer(signals, signalPrograms, signalTicks, tickIndex, frameTime, view, project, lanes = []) {
  const bounds = viewportBounds(view, 2);
  const headsById = new Map((signals ?? []).filter((feature) => feature.kind === 'signal_head').map((head) => [head.id, head]));
  const lanesByRsl = new Map(lanes.map((lane) => [lane.rsl, lane]));
  const layers = [];
  for (const program of [...(signalPrograms ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const phase = signalTicks?.[program.id]?.phase?.[tickIndex] ?? 'off';
    let color = signalColor(phase);
    if (String(phase).startsWith('flashing_') && deterministicFlashPhase(frameTime, 1) === 1) color = '#3a3a3a';
    const arrow = String(phase).endsWith('_arrow');
    for (const headId of [...(program.mapBinding?.headIds ?? [])].sort()) {
      const head = headsById.get(headId);
      if (!head || head.x < bounds.minX || head.x > bounds.maxX || head.y < bounds.minY || head.y > bounds.maxY) continue;
      const c = project(head);
      layers.push(`<circle class="underlay-signal-head" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="5" fill="${color}" stroke="#111" stroke-width="1"/>`);
      if (arrow) {
        const worldDirection = protectedMovementVector(program, head, lanesByRsl);
        const direction = { x: worldDirection.x, y: -worldDirection.y };
        const normal = { x: -direction.y, y: direction.x };
        const points = [
          { x: c.x + direction.x * 13, y: c.y + direction.y * 13 },
          { x: c.x + direction.x * 6 + normal.x * 3, y: c.y + direction.y * 6 + normal.y * 3 },
          { x: c.x + direction.x * 6 - normal.x * 3, y: c.y + direction.y * 6 - normal.y * 3 },
        ];
        layers.push(`<polygon class="underlay-signal-arrow" points="${screenPoints(points)}" fill="${color}"/>`);
      }
    }
  }
  return layers;
}

/**
 * SVG layer strings for everything visible from the camera, in paint order:
 * junction surfaces → non-driving lanes → driving lanes → surface patches →
 * driving boundaries → crosswalk stripes. `project` maps world points to
 * screen points.
 */
export function underlaySvgLayers(underlay, view, project, surfacePatches = [], weatherPreset = null, signalState = null, markingTreatments = []) {
  const { scale } = view;
  const bounds = viewportBounds(view, 14);
  const layers = [];

  const visible = underlay.lanes.filter((lane) => inView(lane, bounds));

  // 1. Junction surface coats.
  for (const lane of visible) {
    if (!lane.isJunction) continue;
    layers.push(
      strokeLayer(
        'underlay-junction',
        lane.pts,
        project,
        JUNCTION_SURFACE_FILL,
        Math.max(1, lane.widthM * JUNCTION_SURFACE_WIDTH_FACTOR * scale),
        '1',
      ),
    );
  }

  // 2. Non-driving lanes, in fixed type order.
  for (const type of NON_DRIVING_ORDER) {
    const style = LANE_STYLES[type] ?? LANE_STYLE_FALLBACK;
    for (const lane of visible) {
      if (lane.laneType !== type) continue;
      layers.push(
        strokeLayer(`underlay-lane-${type}`, lane.pts, project, style.fill, Math.max(1, lane.widthM * scale), '1'),
      );
    }
  }
  // Unstyled types still paint, in sorted-lane order, so nothing silently vanishes.
  for (const lane of visible) {
    if (lane.laneType === 'driving' || NON_DRIVING_ORDER.includes(lane.laneType)) continue;
    layers.push(
      strokeLayer(
        `underlay-lane-${lane.laneType}`,
        lane.pts,
        project,
        LANE_STYLE_FALLBACK.fill,
        Math.max(1, lane.widthM * scale),
        '1',
      ),
    );
  }

  // 3. Driving lanes (junction internals included: their surface coat is already below).
  for (const lane of visible) {
    if (lane.laneType !== 'driving') continue;
    layers.push(
      strokeLayer(
        'underlay-lane-driving',
        lane.pts,
        project,
        LANE_STYLES.driving.fill,
        Math.max(1, lane.widthM * scale),
        '1',
      ),
    );
  }

  // 4. Authored surface coverings sit on the asphalt, below physical markings.
  layers.push(...surfacePatchSvgLayer(surfacePatches, { ...view, lanes: underlay.lanes }, project));

  // 5. Boundary lines on non-junction driving lanes. Authored appearance and
  // surface/weather obscuration share one segmented path, so a local window
  // changes only the paint it actually covers. Marking displacement never
  // changes `lane.pts`, which remains the simulation/map truth.
  const weatherObscuresMarkings = weatherPreset === 'snow' || weatherPreset === 'sleet';
  const sortedTreatments = [...(markingTreatments ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const lane of visible) {
    if (lane.laneType !== 'driving' || lane.isJunction) continue;
    const lengthM = polylineLength(lane.pts);
    const authored = sortedTreatments.filter((item) => item.region?.kind === 'laneWindow' && item.region.rsl === lane.rsl);
    const obscured = surfacePatches.filter((item) => item.region?.kind === 'laneWindow' && item.region.rsl === lane.rsl);
    const breakpoints = [0, lengthM];
    for (const item of [...authored, ...obscured]) {
      breakpoints.push(Math.max(0, Math.min(lengthM, item.region.sMin)));
      breakpoints.push(Math.max(0, Math.min(lengthM, item.region.sMax)));
    }
    breakpoints.sort((a, b) => a - b);
    const uniqueBreakpoints = breakpoints.filter((value, index) => index === 0 || value - breakpoints[index - 1] > 1e-6);
    for (let i = 1; i < uniqueBreakpoints.length; i += 1) {
      const sMin = uniqueBreakpoints[i - 1];
      const sMax = uniqueBreakpoints[i];
      if (sMax - sMin <= 1e-6) continue;
      const midpoint = (sMin + sMax) / 2;
      const explicit = authored.find((item) => midpoint >= item.region.sMin && midpoint <= item.region.sMax);
      const covered = obscured.some((item) => midpoint >= item.region.sMin && midpoint <= item.region.sMax);
      const authoredQuality = explicit?.quality ?? 'crisp';
      if (authoredQuality === 'absent') continue;
      const quality = (weatherObscuresMarkings || covered) ? 'obscured' : authoredQuality;
      const style = MARKING_STYLES[quality] ?? MARKING_STYLES.crisp;
      const center = polylineWindow(lane.pts, sMin, sMax);
      if (center.length < 2) continue;
      for (const side of [1, -1]) {
        const markingOffsetM = side * (lane.widthM / 2)
          + (authoredQuality === 'misaligned' ? MISALIGNED_MARKING_OFFSET_M : 0);
        layers.push(
          strokeLayer(
            quality === 'crisp' ? 'underlay-boundary' : `underlay-boundary underlay-boundary-${quality}`,
            offsetPolyline(center, markingOffsetM),
            project,
            BOUNDARY_STROKE,
            1.2,
            style.opacity,
            style.dash,
          ),
        );
      }
    }
  }

  // 6. Crosswalk zebra stripes.
  for (const cw of underlay.crosswalks) {
    if (cw.x < bounds.minX || cw.x > bounds.maxX || cw.y < bounds.minY || cw.y > bounds.maxY) continue;
    const stripes = Math.max(1, Math.floor((2 * cw.halfSpanM) / CROSSWALK_PITCH_M));
    const start = -((stripes - 1) / 2) * CROSSWALK_PITCH_M;
    for (let i = 0; i < stripes; i += 1) {
      const corners = stripeCorners(cw, start + i * CROSSWALK_PITCH_M);
      layers.push(
        `<polygon class="underlay-crosswalk" points="${screenPolyline(corners, project)}" fill="${CROSSWALK_STRIPE_FILL}" opacity="0.55"/>`,
      );
    }
  }

  // 7. Static road-sign furniture.
  layers.push(...signSvgLayer(underlay.furniture, view, project));

  // 8. Dynamic physical heads, joined to logical trace programs by head id.
  if (signalState) {
    layers.push(...signalSvgLayer(
      underlay.furniture,
      signalState.programs,
      signalState.ticks,
      signalState.tickIndex,
      signalState.frameTime,
      view,
      project,
      underlay.lanes,
    ));
  }

  return layers;
}

// --- actor glyphs ------------------------------------------------------------

/** Disc-rendered kinds: class must be legible to a vision judge at ~5 px. */
const DISC_KINDS = new Map([
  ['pedestrian', '#ff5a5f'],
  ['bicycle', '#e67e22'],
  ['cyclist', '#e67e22'],
  ['scooter', '#e67e22'],
  ['animal', '#d98f4a'],
  ['sidewalk_robot', '#b48fd9'],
  ['drone', '#b48fd9'],
]);

const MOTORCYCLE_FILL = '#c07fe8';
const EGO_FILL = '#45a3ff';
const STATIC_FILL = '#ffc166';
const VEHICLE_FILL = '#84d65a';

/**
 * Shape and color for one actor, from `trace.header.actorMetadata[id].kind`
 * (authoritative; pass `null` for pre-metadata traces, which keeps the legacy
 * literal-id behavior: only 'ped' was ever a disc). Precedence: ego blue >
 * disc-class color > static amber > motorcycle violet > vehicle green.
 * Static VRUs keep their class color — the class is what the judge must see.
 */
export function actorGlyph(id, kind, isStatic) {
  if (id === 'ego') return { shape: 'box', color: EGO_FILL };
  const resolved = kind ?? (id === 'ped' ? 'pedestrian' : null);
  const disc = resolved === null ? undefined : DISC_KINDS.get(resolved);
  if (disc !== undefined) return { shape: 'disc', color: disc };
  if (isStatic) return { shape: 'box', color: STATIC_FILL };
  if (resolved === 'motorcycle') return { shape: 'box', color: MOTORCYCLE_FILL };
  return { shape: 'box', color: VEHICLE_FILL };
}

// --- recorded discrete actor state -------------------------------------------

/**
 * Latest recorded value for an actor state key at or before `t`.
 *
 * The trace's `state_set` events are authoritative runtime state. Equal-time
 * events retain trace order, so the last matching event wins deterministically.
 */
export function stateValueAt(events, actorId, key, t) {
  let value;
  let valueT = -Infinity;
  for (const e of events ?? []) {
    if (e.kind !== 'state_set' || e.actorId !== actorId || e.key !== key) continue;
    if (e.t > t || e.t < valueT) continue;
    value = e.value;
    valueT = e.t;
  }
  return value;
}

/** Deterministic binary flash phase from frame time: 0 or 1, no wall clock. */
export function deterministicFlashPhase(t, hz) {
  return Math.floor(t * hz * 2) % 2 === 0 ? 0 : 1;
}
