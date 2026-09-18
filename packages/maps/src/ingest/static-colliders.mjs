import { createHash } from 'node:crypto';

export const STATIC_COLLIDER_SCHEMA = 'simforge.static-map-colliders/v1';
const TRAVEL_LANE_TYPES = new Set(['driving', 'biking', 'parking', 'shoulder']);
const ROAD_INDEX_CELL_M = 20;
const COLLIDER_CLASSES = ['building', 'wall', 'barrier', 'prop', 'road-boundary'];
/**
 * A kerb or guardrail is a strip; its OBB stands in for it only while the strip
 * is thin. Authoring exports (RoadRunner, Unreal) also emit one merged
 * `Roads_Curb` mesh for the whole map, whose bounding box is the map itself:
 * that OBB would be a solid slab every vehicle spawns inside, so a
 * road-boundary node thicker than this is not a collider at all. The same
 * export style merges a tile's whole guardrail network into one mesh
 * (`Prop_RoadGuardRail_63`: 500 m × 167 m on Garching); one box cannot stand
 * in for that either, and this rule drops it too.
 */
const ROAD_BOUNDARY_MAX_THICKNESS_M = 2;
/** Below this a box is numerically degenerate rather than an obstacle. */
const MIN_EXTENT_M = 0.08;
/**
 * Paint, road reflectors, manhole covers and the disc-shaped insulator props
 * are flat: a vehicle drives over them. Height is the one vertical measure
 * these sources support. The authored vertical datum differs per map (node
 * floors run from 0 m to 490 m across the ten exports) and relief inside a map
 * reaches 30 m, so nothing may be excluded for *being high up*: a mast arm
 * over the carriageway is rejected by the travel-lane test instead, and a
 * hillside building keeps its collider.
 */
const MIN_OBSTACLE_HEIGHT_M = 0.15;
/** Footprint and height at which an unnamed box is reported as a building. */
const BUILDING_MIN_FOOTPRINT_M2 = 60;
const BUILDING_MIN_HEIGHT_M = 3;

/**
 * Solid by default.
 *
 * Mesh nodes in these exports are named after the Unreal/FBX component that
 * emitted them, not after what they are: the commonest mesh-node name tokens
 * across the ten authored sources are `InstancedStaticMeshComponent`, `Prop`
 * and `HierarchicalInstancedStaticMeshComponent`. Semantics, where they exist,
 * live on ancestors (`Roads_Road`, `Trees`, `{guid}Sign_R1-1_1`) or on
 * project-coded roots that no word list can predict: `3_2_VWB_8_9` and
 * `9_8_VWB_16` are Belmont's office blocks, `97_Bu_6` Richmond's, `21_18_B_01`
 * Saratoga's, `182_27_SRB_17` San Ramon's. An inclusion list over node names
 * therefore left 4842 of Belmont's 4869 mesh nodes `ignored` — every building
 * among them — and vehicles drove through the visible geometry.
 *
 * So a mesh with real volume is an obstacle unless something *states* it is
 * not one. The exclusions, and only these, are:
 *
 * - `surface`: the exporter's road and ground taxonomy — a `Roads`/`Terrain`
 *   asset-layer subtree (`Roads_Road`, `Roads_Marking`, `Roads_Sidewalk`,
 *   `Roads_Gutter`, `Terrain_Ground`, …) or a name that says road, marking,
 *   pavement, sidewalk, gutter, terrain or ground. Nothing structural lives
 *   under those groups in any of the ten sources: zero nodes there name a
 *   fence, wall, guardrail, barrier or building. The travel-lane test already
 *   rejects what sits on a driving, biking, parking or shoulder lane, but it
 *   cannot reject the map-sized merged surface slabs, whose centres land
 *   off-lane, nor parking-bay and driveway paving that carries no lane at all.
 * - `foliage`: a `Trees`/`Bushes`/`Vegetation`/`Plantfactory` subtree. A bush
 *   must not stop a car, and these are 16–22 m instanced canopies (39 m on
 *   Belmont) whose single mesh contains the trunk, so excluding the canopy
 *   necessarily excludes the trunk — no source separates them. A 0.4 m trunk
 *   is therefore not a collider: that is the deliberate price of not putting a
 *   20 m phantom wall across every verge.
 * - `flat`, `tiny`, `degenerate`: no volume to hit (see the constants above).
 * - `mergedBoundary`: a kerb or guardrail network merged into one mesh.
 *
 * Everything else — including the 0.3 m fire hydrants and sign posts, which
 * are solid — becomes a collider, classed from the same names when they say
 * something and from its size when they do not.
 */
const FOLIAGE_TOKEN = /^(?:trees?|bush(?:es)?|brush|shrubs?|hedges?|foliage|vegetation|canopy|grass|plant\w*)$/;
const SURFACE_TOKENS = new Set(['road', 'roads', 'roadway', 'marking', 'markings', 'pavement', 'paving', 'asphalt', 'sidewalk', 'walkway', 'gutter', 'terrain', 'ground']);
const WALL_TOKENS = new Set(['fence', 'fences', 'fencing', 'wall', 'walls', 'railing', 'parapet']);
const BARRIER_TOKENS = new Set(['barrier', 'barriers', 'bollard', 'bollards', 'border', 'jersey', 'block', 'blocks']);
const BUILDING_TOKENS = new Set(['building', 'buildings', 'bldg', 'house', 'houses', 'office', 'offices', 'facade', 'roof', 'garage', 'hangar', 'shed', 'warehouse', 'structure']);
/**
 * `extras.category` is authoritative when an exporter writes it — and none of
 * the ten current sources writes it: not one node in any of them carries
 * `extras` at all. It is kept for exporters that will, and must not be
 * mistaken for the working path again. Every classification that fires today
 * comes from names and geometry.
 */
const EXTRA_CATEGORY_TRAITS = new Map([
  ['building', 'building'], ['wall', 'wall'], ['fence', 'wall'], ['barrier', 'barrier'],
  ['prop', 'prop'], ['curb', 'road-boundary'], ['kerb', 'road-boundary'], ['guardrail', 'road-boundary'],
  ['road', 'surface'], ['ground', 'surface'], ['terrain', 'surface'], ['marking', 'surface'],
  ['vegetation', 'foliage'], ['foliage', 'foliage'], ['tree', 'foliage'],
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function extractGlbColliders(buffer, tileId) {
  return extractJsonColliders(readGlbJson(buffer, tileId), tileId);
}

function extractJsonColliders(json, tileId) {
  const nodes = json.nodes ?? [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, index) => index);
  const colliders = [];
  const exclusions = { surface: 0, foliage: 0, flat: 0, tiny: 0, degenerate: 0, mergedBoundary: 0 };
  let ignored = 0;
  const exclude = (reason) => { exclusions[reason] += 1; ignored += 1; };
  const visit = (index, parent, inherited) => {
    const node = nodes[index];
    if (!node) return;
    const world = multiply4(parent, nodeMatrix(node));
    // The chain's verdict descends instead of being recomputed: a 50k-node
    // export would otherwise re-tokenize every ancestor name per mesh. A name
    // that says something overrides its ancestors, because the deeper name is
    // the more specific one (`Roads_Curb` under `Roads`).
    const trait = nodeTrait(node) ?? inherited;
    if (node.mesh !== undefined) {
      const bounds = meshBounds(json, node.mesh);
      if (!bounds) exclude('degenerate');
      else if (trait === 'surface') exclude('surface');
      else if (trait === 'foliage') exclude('foliage');
      else {
        const obb = projectedObb(bounds, world);
        const collisionClass = trait ?? sizedClass(obb);
        if (!Number.isFinite(obb.center.x + obb.center.z)) exclude('degenerate');
        else if (obb.lengthM < MIN_EXTENT_M || obb.widthM < MIN_EXTENT_M) exclude('tiny');
        else if (obb.heightM < MIN_OBSTACLE_HEIGHT_M) exclude('flat');
        else if (collisionClass === 'road-boundary' && Math.min(obb.lengthM, obb.widthM) > ROAD_BOUNDARY_MAX_THICKNESS_M) exclude('mergedBoundary');
        else colliders.push({ id: `${tileId}/${index}`, class: collisionClass, obb: { center: obb.center, lengthM: obb.lengthM, widthM: obb.widthM, headingRad: obb.headingRad } });
      }
    }
    for (const child of node.children ?? []) visit(child, world, trait);
  };
  for (const root of roots) visit(root, IDENTITY, null);
  return { colliders, ignored, exclusions };
}

/**
 * Collider sources are the highest LOD of every tile **and** every static layer.
 *
 * Tiles alone was correct only for the external city pipeline, which puts all
 * geometry in tiles. A map assembled from an authored `.xodr` plus one GLB per
 * layer has `tiles: []` and keeps everything in `staticLayers`, so scanning
 * tiles alone produced a structurally valid artifact that collided with nothing
 * — the worst kind of wrong, because every downstream check passes.
 *
 * For a city-pipeline map this adds only its static layers, which are road and
 * terrain surfaces: their nodes classify to `road-boundary` or to nothing, so no
 * building collider appears where one did not before. A rebuild of such a map
 * may gain kerb and guardrail colliders, which is the point of that class rather
 * than a side effect. Published closures are immutable, so nothing already
 * published moves.
 */
export function buildStaticColliderArtifact({ mapId, sourceManifestSha256, manifest, topology, readSource, canonicalGltf }) {
  if (!Array.isArray(manifest.tiles)) throw new Error('Static collision manifest has no tile list');
  const tileSources = manifest.tiles.map((tile, index) => {
    const lod = [...(tile.lods ?? [])].sort((a, b) => b.level - a.level || a.file.localeCompare(b.file))[0];
    if (!lod) throw new Error(`Static collision tile ${tile.id ?? index} has no LOD`);
    return { id: tile.id ?? `tile-${index}`, file: lod.file, declaredBytes: lod.fileSize ?? null };
  });
  const layerSources = (manifest.staticLayers ?? []).map((layer, index) => {
    if (typeof layer.file !== 'string' || layer.file.length === 0) {
      throw new Error(`Static collision layer ${layer.id ?? index} has no file`);
    }
    return { id: layer.id ?? `layer-${index}`, file: layer.file, declaredBytes: layer.fileSize ?? null };
  });
  const selected = canonicalGltf
    ? [{ id: 'canonical-master', file: canonicalGltf.file, declaredBytes: canonicalGltf.bytes.length }]
    : [...tileSources, ...layerSources].sort((a, b) => a.id.localeCompare(b.id));
  const classes = Object.fromEntries(COLLIDER_CLASSES.map((name) => [name, 0]));
  const travelLaneIndex = buildTravelLaneIndex(topology);
  const colliders = []; const sources = [];
  let rejectedRoadOverlap = 0; let ignored = 0;
  for (const tile of selected) {
    const bytes = canonicalGltf ? canonicalGltf.bytes : readSource(tile.file);
    sources.push({ id: tile.id, file: tile.file, declaredBytes: tile.declaredBytes });
    const extracted = canonicalGltf
      ? extractJsonColliders(JSON.parse(bytes.toString('utf8')), tile.id)
      : extractGlbColliders(bytes, tile.id);
    ignored += extracted.ignored;
    for (const collider of extracted.colliders) {
      if (collider.class !== 'road-boundary' && overlapsTravelLane({ obb: footprintCore(collider.obb) }, travelLaneIndex)) { rejectedRoadOverlap += 1; continue; }
      classes[collider.class] += 1;
      colliders.push(collider);
    }
  }
  colliders.sort((a, b) => a.id.localeCompare(b.id));
  const payload = { schema: STATIC_COLLIDER_SCHEMA, mapId, sourceManifestSha256, sources, colliders,
    statistics: { sourceTiles: selected.length, accepted: colliders.length, rejectedRoadOverlap, ignored, classes } };
  return { ...payload, digest: `sha256-${sha256(Buffer.from(JSON.stringify(payload)))}` };
}

export function serializeStaticColliderArtifact(artifact) { return `${JSON.stringify(artifact)}\n`; }

function readGlbJson(buffer, tileId) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2) throw new Error(`Static collision tile ${tileId} is not GLB v2`);
  const jsonLength = buffer.readUInt32LE(12);
  if (jsonLength <= 0 || 20 + jsonLength > buffer.length || buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Static collision tile ${tileId} has no valid JSON chunk`);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\0 ]+$/, ''));
}

/**
 * One node's own verdict, or `null` when its name says nothing and the
 * ancestor chain's verdict stands. Names are split on separators *and* on
 * camel-case boundaries and matched whole: `StreetLight_30ft` must not read as
 * a tree, and `Roadside_Barrier` must not read as road surface.
 */
function nodeTrait(node) {
  const category = node.extras?.category?.toLowerCase();
  if (category) return EXTRA_CATEGORY_TRAITS.get(category) ?? null;
  const name = node.name;
  if (!name) return null;
  let boundary = false; let foliage = false; let surface = false; let building = false; let wall = false; let barrier = false;
  let previous = '';
  for (const token of nameTokens(name)) {
    if (token === 'curb' || token === 'kerb' || token === 'guardrail' || (token === 'rail' && previous === 'guard') || (token === 'edge' && previous === 'road')) boundary = true;
    else if (FOLIAGE_TOKEN.test(token)) foliage = true;
    else if (SURFACE_TOKENS.has(token)) surface = true;
    else if (BUILDING_TOKENS.has(token)) building = true;
    else if (WALL_TOKENS.has(token)) wall = true;
    else if (BARRIER_TOKENS.has(token)) barrier = true;
    previous = token;
  }
  // A kerb layer is named `Roads_Curb`, a guardrail prop `Prop_RoadGuardRail`:
  // the boundary word is the specific one, so it outranks `road`. Likewise
  // `2300-16569_Building_38_Fence` is a fence, not a building — the object
  // word beats the word naming the plot it belongs to.
  if (boundary) return 'road-boundary';
  if (foliage) return 'foliage';
  if (surface) return 'surface';
  if (wall) return 'wall';
  if (barrier) return 'barrier';
  if (building) return 'building';
  return null;
}

/**
 * Word tokens of one node name. Camel-case boundaries and digit runs both
 * separate: the exports number their groups (`Vegetation2`, `Bushes_v1`,
 * `Roads_Curb_Layer0`, `TreesP1`), and a token that keeps its index matches
 * nothing. GUIDs that Unreal prefixes onto asset names carry no meaning.
 */
function nameTokens(name) {
  return name.replace(/\{[0-9a-fA-F-]+\}/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    .split(/[^a-z]+/).filter((token) => token.length > 0);
}

/**
 * When no name in the chain says what a mesh is — Belmont's `3_2_VWB_8_9`,
 * Richmond's `97_Bu_6` — its size does: a box with a building-sized footprint
 * that stands three metres tall is reported as a building, and everything else
 * admitted is a prop. This decides only the reported class, never admission.
 */
function sizedClass(obb) {
  return obb.lengthM * obb.widthM >= BUILDING_MIN_FOOTPRINT_M2 && obb.heightM >= BUILDING_MIN_HEIGHT_M ? 'building' : 'prop';
}

function meshBounds(json, meshIndex) {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity]; let found = false;
  for (const primitive of json.meshes?.[meshIndex]?.primitives ?? []) {
    const accessor = primitive.attributes?.POSITION === undefined ? undefined : json.accessors?.[primitive.attributes.POSITION];
    if (!accessor?.min || !accessor.max || accessor.min.length < 3 || accessor.max.length < 3) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], normalizedAccessorValue(accessor, accessor.min[axis]));
      max[axis] = Math.max(max[axis], normalizedAccessorValue(accessor, accessor.max[axis]));
    }
    found = true;
  }
  return found ? { min, max } : null;
}

function normalizedAccessorValue(accessor, value) {
  if (!accessor.normalized) return value;
  if (accessor.componentType === 5120) return Math.max(value / 127, -1);
  if (accessor.componentType === 5121) return value / 255;
  if (accessor.componentType === 5122) return Math.max(value / 32767, -1);
  if (accessor.componentType === 5123) return value / 65535;
  return value;
}

function projectedObb(bounds, matrix) {
  const centerLocal = bounds.min.map((value, index) => (value + bounds.max[index]) / 2);
  const center3 = transformPoint(matrix, centerLocal);
  const basis = transformVector(matrix, [1, 0, 0]);
  // Browser map GLBs already use the editor's x/z scene frame. Negating z
  // here mirrored every collider across the x axis while the visible mesh
  // remained in its authored location.
  const headingRad = Math.atan2(basis[2], basis[0]);
  const forward = [Math.cos(headingRad), Math.sin(headingRad)]; const left = [-forward[1], forward[0]];
  let halfLength = 0; let halfWidth = 0;
  // `heightM` never reaches the artifact — the published OBB stays a 2D
  // footprint — but admission needs it: a painted arrow and a wall have the
  // same footprint and only one of them can be hit.
  let minY = Infinity; let maxY = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    const point = transformPoint(matrix, [x, y, z]); const dx = point[0] - center3[0]; const dz = point[2] - center3[2];
    halfLength = Math.max(halfLength, Math.abs(dx * forward[0] + dz * forward[1]));
    halfWidth = Math.max(halfWidth, Math.abs(dx * left[0] + dz * left[1]));
    minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
  }
  return { center: { x: center3[0], z: center3[2] }, lengthM: halfLength * 2, widthM: halfWidth * 2, headingRad, heightM: maxY - minY };
}

/**
 * The lane test answers "does a travel lane run *through* this footprint?".
 *
 * `buildTravelLaneIndex` already pads every lane sample by half the lane's
 * width plus 0.75 m, so comparing a footprint to that padded sample rejects
 * everything standing within a lane-and-a-bit of the centreline — including
 * geometry that is merely beside the road. Measured on Belmont: of 93 vetoed
 * candidates, 78 are lamp posts, signal posts, hydrants and parking blocks
 * whose footprints lie 1–3 m *outside* the lane, plus kerbside office blocks.
 * Deleting those is the same fail-open defect as never classifying them.
 *
 * Deflating the footprint by the margin the index adds cancels the two, so the
 * test means what it says: the lane's centreline crosses the footprint. Extents
 * may go negative, which correctly tightens the band for sub-metre props — a
 * lamp post is rejected only while it stands on the centreline itself. The
 * lane functions themselves are untouched.
 */
const ROADSIDE_MARGIN_M = 2.5;
function footprintCore(obb) {
  return { center: obb.center, headingRad: obb.headingRad, lengthM: obb.lengthM - 2 * ROADSIDE_MARGIN_M, widthM: obb.widthM - 2 * ROADSIDE_MARGIN_M };
}

function buildTravelLaneIndex(topology) {
  const buckets = new Map();
  for (const lane of Object.values(topology.lanes ?? {})) {
    if (!TRAVEL_LANE_TYPES.has(lane.laneType)) continue;
    const clearance = Math.max(1, (lane.representativeWidthM ?? 3.5) / 2 + 0.75);
    for (const point of lane.polyline ?? []) {
      const x = Array.isArray(point) ? point[0] : point.x; const z = -(Array.isArray(point) ? point[1] : point.y);
      const key = `${Math.floor(x / ROAD_INDEX_CELL_M)},${Math.floor(z / ROAD_INDEX_CELL_M)}`;
      const bucket = buckets.get(key) ?? []; bucket.push({ x, z, clearance }); buckets.set(key, bucket);
    }
  }
  return { buckets, populatedCells: [...buckets.keys()].map((key) => key.split(',').map(Number)) };
}

function overlapsTravelLane(collider, index) {
  const { obb } = collider; const cos = Math.cos(obb.headingRad); const sin = Math.sin(obb.headingRad);
  const radius = Math.hypot(obb.lengthM, obb.widthM) / 2 + 3;
  const x0 = Math.floor((obb.center.x - radius) / ROAD_INDEX_CELL_M); const x1 = Math.floor((obb.center.x + radius) / ROAD_INDEX_CELL_M);
  const z0 = Math.floor((obb.center.z - radius) / ROAD_INDEX_CELL_M); const z1 = Math.floor((obb.center.z + radius) / ROAD_INDEX_CELL_M);
  const gridArea = (x1 - x0 + 1) * (z1 - z0 + 1);
  const cells = gridArea <= 4096
    ? function* boundedCells() { for (let gx = x0; gx <= x1; gx += 1) for (let gz = z0; gz <= z1; gz += 1) yield [gx, gz]; }()
    : index.populatedCells.filter(([gx, gz]) => gx >= x0 && gx <= x1 && gz >= z0 && gz <= z1);
  for (const [gx, gz] of cells) for (const sample of index.buckets.get(`${gx},${gz}`) ?? []) {
    const dx = sample.x - obb.center.x; const dz = sample.z - obb.center.z;
    if (Math.abs(dx * cos + dz * sin) <= obb.lengthM / 2 + sample.clearance && Math.abs(-dx * sin + dz * cos) <= obb.widthM / 2 + sample.clearance) return true;
  }
  return false;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function nodeMatrix(node) {
  if (node.matrix?.length === 16) return [...node.matrix];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]; const [sx, sy, sz] = node.scale ?? [1, 1, 1]; const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const x2 = x + x; const y2 = y + y; const z2 = z + z; const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2; const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, tx, ty, tz, 1];
}
function multiply4(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return out;
}
function transformPoint(matrix, point) { return [matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12], matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13], matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14]]; }
function transformVector(matrix, point) { return [matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2], matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2], matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2]]; }
