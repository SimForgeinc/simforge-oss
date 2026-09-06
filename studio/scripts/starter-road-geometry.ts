import { Buffer } from "node:buffer";

/**
 * Authored dimensions of the starter road in OpenDRIVE-local metres (x east
 * along the road, y north across it, z up). The seed's OpenDRIVE text and its
 * road GLB are both generated from this one record, so the lane topology, the
 * rendered mesh and the static colliders derived from that mesh cannot
 * disagree about where the road is.
 */
export const STARTER_ROAD = Object.freeze({
  lengthM: 200,
  laneWidthM: 3.5,
  /** Solid yellow centre line on the reference line. */
  centreMarkWidthM: 0.15,
  /** Broken white line on each outer lane edge. */
  edgeMarkWidthM: 0.12,
  edgeMarkDashM: 3,
  edgeMarkGapM: 6,
  slabDepthM: 0.2,
  /** Lifts markings off the slab so they do not z-fight the asphalt. */
  markingLiftM: 0.01,
  /**
   * One solid building beside the right lane (negative y is right of travel),
   * clear of every travel lane, so the static-collider derivative has a real
   * obstacle to describe.
   */
  building: { west: 20, east: 40, south: -22, north: -10, heightM: 8 },
});

export const STARTER_ROAD_HALF_LENGTH_M = STARTER_ROAD.lengthM / 2;

type Vec3 = [number, number, number];
type Box = { min: Vec3; max: Vec3 };
type TriangleMesh = { positions: number[]; normals: number[]; indices: number[] };

/**
 * OpenDRIVE-local (x east, y north, z up) axis-aligned box to the y-up scene
 * frame, the same swap `CoordinateFrame.localToScene` applies: `[x, z, -y]`.
 */
function localBox(
  west: number, east: number, south: number, north: number, bottom: number, top: number,
): Box {
  return { min: [west, bottom, -north], max: [east, top, -south] };
}

function face(mesh: TriangleMesh, normal: Vec3, corners: [Vec3, Vec3, Vec3, Vec3]): void {
  const base = mesh.positions.length / 3;
  for (const corner of corners) {
    mesh.positions.push(...corner);
    mesh.normals.push(...normal);
  }
  mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Counter-clockwise faces seen from outside, so every normal points outward. */
function box(mesh: TriangleMesh, { min: [x0, y0, z0], max: [x1, y1, z1] }: Box): void {
  face(mesh, [0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]);
  face(mesh, [0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
  face(mesh, [1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
  face(mesh, [-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  face(mesh, [0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  face(mesh, [0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]);
}

/**
 * A longitudinal painted line centred on local `y`, from `from` to `to` along
 * x: an upward-facing quad just above the slab, since markings are painted,
 * not extruded.
 */
function paintedLine(mesh: TriangleMesh, y: number, widthM: number, from: number, to: number): void {
  const { min: [x0, , z0], max: [x1, y1, z1] } = localBox(
    from, to, y - widthM / 2, y + widthM / 2, STARTER_ROAD.markingLiftM, STARTER_ROAD.markingLiftM,
  );
  face(mesh, [0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]);
}

function brokenLine(mesh: TriangleMesh, y: number): void {
  const { edgeMarkWidthM, edgeMarkDashM, edgeMarkGapM } = STARTER_ROAD;
  const end = STARTER_ROAD_HALF_LENGTH_M;
  for (let start = -end; start < end; start += edgeMarkDashM + edgeMarkGapM) {
    paintedLine(mesh, y, edgeMarkWidthM, start, Math.min(start + edgeMarkDashM, end));
  }
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;

type GltfAccessor = {
  bufferView: number;
  componentType: number;
  count: number;
  type: "VEC3" | "SCALAR";
  min?: number[];
  max?: number[];
};
type GltfBufferView = { buffer: 0; byteOffset: number; byteLength: number; target: number };
type GltfPrimitive = {
  attributes: { POSITION: number; NORMAL: number };
  indices: number;
  material: number;
  mode: typeof TRIANGLES;
};

class GlbAssembler {
  readonly chunks: Buffer[] = [];
  readonly bufferViews: GltfBufferView[] = [];
  readonly accessors: GltfAccessor[] = [];
  #byteLength = 0;

  #view(bytes: Buffer, target: number): number {
    const padded = (bytes.length + 3) & ~3;
    this.chunks.push(bytes, Buffer.alloc(padded - bytes.length));
    this.bufferViews.push({ buffer: 0, byteOffset: this.#byteLength, byteLength: bytes.length, target });
    this.#byteLength += padded;
    return this.bufferViews.length - 1;
  }

  vec3(values: number[], withBounds: boolean): number {
    const data = Float32Array.from(values);
    const accessor: GltfAccessor = {
      bufferView: this.#view(Buffer.from(data.buffer), ARRAY_BUFFER),
      componentType: FLOAT,
      count: data.length / 3,
      type: "VEC3",
    };
    if (withBounds) {
      // Bounds are stated on the float32 values actually stored, not the doubles they came from.
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let index = 0; index < data.length; index += 1) {
        const axis = index % 3;
        min[axis] = Math.min(min[axis]!, data[index]!);
        max[axis] = Math.max(max[axis]!, data[index]!);
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  indices(values: number[]): number {
    const data = Uint16Array.from(values);
    this.accessors.push({
      bufferView: this.#view(Buffer.from(data.buffer), ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_SHORT,
      count: data.length,
      type: "SCALAR",
    });
    return this.accessors.length - 1;
  }

  primitive(mesh: TriangleMesh, material: number): GltfPrimitive {
    if (mesh.positions.length / 3 > 0xffff) throw new Error("starter road primitive exceeds uint16 indices");
    return {
      attributes: { POSITION: this.vec3(mesh.positions, true), NORMAL: this.vec3(mesh.normals, false) },
      indices: this.indices(mesh.indices),
      material,
      mode: TRIANGLES,
    };
  }

  get bin(): Buffer {
    return Buffer.concat(this.chunks, this.#byteLength);
  }
}

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/** Standard two-chunk GLB; the JSON chunk is space-padded, the BIN chunk zero-padded. */
function writeGlb(json: unknown, bin: Buffer): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binPadded = (bin.length + 3) & ~3;
  const out = Buffer.alloc(12 + 8 + jsonPadded + 8 + binPadded);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonPadded, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded);
  const binHeader = 20 + jsonPadded;
  out.writeUInt32LE(binPadded, binHeader);
  out.writeUInt32LE(BIN_CHUNK, binHeader + 4);
  bin.copy(out, binHeader + 8);
  return out;
}

/**
 * The starter road layer as a binary glTF: an asphalt slab, painted lane
 * markings and one building, all authored from {@link STARTER_ROAD}.
 *
 * Node and material names follow the pipeline's `<Group>_<Kind>_Layer<N>` /
 * `<Texture>_<Kind>` convention, which is what every downstream classifier
 * keys on: the semantics builder reads `road` / `building` off the node names,
 * the collider builder accepts only the `*Building*` node as a solid, and the
 * roadway audit counts `*_Marking` and `Asphalt*` materials.
 */
export function buildStarterRoadGlb(): Buffer {
  const half = STARTER_ROAD_HALF_LENGTH_M;
  const { laneWidthM, slabDepthM, centreMarkWidthM, building } = STARTER_ROAD;

  const slab: TriangleMesh = { positions: [], normals: [], indices: [] };
  box(slab, localBox(-half, half, -laneWidthM, laneWidthM, -slabDepthM, 0));
  const edgeMarkings: TriangleMesh = { positions: [], normals: [], indices: [] };
  brokenLine(edgeMarkings, laneWidthM);
  brokenLine(edgeMarkings, -laneWidthM);
  const centreMarking: TriangleMesh = { positions: [], normals: [], indices: [] };
  paintedLine(centreMarking, 0, centreMarkWidthM, -half, half);
  const house: TriangleMesh = { positions: [], normals: [], indices: [] };
  box(house, localBox(building.west, building.east, building.south, building.north, 0, building.heightM));

  const glb = new GlbAssembler();
  const materials = [
    { name: "Asphalt1_Road", pbrMetallicRoughness: { baseColorFactor: [0.16, 0.16, 0.17, 1], metallicFactor: 0, roughnessFactor: 0.95 } },
    { name: "LaneMarking1_Marking", pbrMetallicRoughness: { baseColorFactor: [0.92, 0.92, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
    { name: "LaneMarking2_Marking", pbrMetallicRoughness: { baseColorFactor: [0.93, 0.76, 0.16, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
    { name: "Brick1_Building", pbrMetallicRoughness: { baseColorFactor: [0.55, 0.32, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  ];
  const meshes = [
    { name: "Roads_Road_Layer0", primitives: [glb.primitive(slab, 0)] },
    {
      name: "Roads_Marking_Layer0",
      primitives: [glb.primitive(edgeMarkings, 1), glb.primitive(centreMarking, 2)],
    },
    { name: "Buildings_Building_Layer0", primitives: [glb.primitive(house, 3)] },
  ];
  const bin = glb.bin;
  return writeGlb({
    asset: { version: "2.0", generator: "simforge-starter-map" },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, index) => index) }],
    nodes: meshes.map((mesh, index) => ({ name: mesh.name, mesh: index })),
    meshes,
    materials,
    accessors: glb.accessors,
    bufferViews: glb.bufferViews,
    buffers: [{ byteLength: bin.length }],
  }, bin);
}
