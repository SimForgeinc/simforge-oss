import type { GltfDocument, GltfMaterial } from './gltf-read.js';
import type { AttributeData, PrimitiveData } from './mesh-ops.js';

/**
 * Writes derivative meshes as plain glTF 2.0 (one external buffer, no
 * compression or quantization extensions) so any stock loader, Bevy's
 * included, reads them. Every attribute keeps its source accessor encoding
 * (component type, normalization, type): a renderer that swaps a master
 * primitive for its LOD sees the same vertex layout and needs no new
 * pipeline specialization.
 */

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const align4 = (n: number): number => (n + 3) & ~3;

export interface WriterPrimitive {
  data: PrimitiveData;
  material?: number;
}

export interface WriterMesh {
  name: string;
  primitives: WriterPrimitive[];
  extras?: Record<string, unknown>;
}

export class GltfWriter {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  readonly json: GltfDocument;

  constructor(generator: string, private readonly bufferUri: string) {
    this.json = { asset: { version: '2.0', generator }, buffers: [], bufferViews: [], accessors: [], meshes: [] };
  }

  private view(bytes: Buffer, target: number, byteStride?: number): number {
    const padding = align4(this.byteLength) - this.byteLength;
    if (padding) {
      this.chunks.push(Buffer.alloc(padding));
      this.byteLength += padding;
    }
    const index = this.json.bufferViews!.length;
    this.json.bufferViews!.push({ buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength, ...(byteStride ? { byteStride } : {}), target } as never);
    this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
    return index;
  }

  private attribute(semantic: string, attribute: AttributeData): number {
    const k = attribute.components;
    const count = attribute.data.length / k;
    const componentBytes = COMPONENT_BYTES[attribute.componentType]!;
    const elementBytes = componentBytes * k;
    const stride = align4(elementBytes);
    const bytes = Buffer.alloc(stride * count);
    const scale = !attribute.normalized ? 1
      : attribute.componentType === 5121 ? 255
        : attribute.componentType === 5123 ? 65535
          : attribute.componentType === 5120 ? 127
            : attribute.componentType === 5122 ? 32767 : 1;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < k; c++) {
        const value = attribute.data[i * k + c]!;
        const offset = i * stride + c * componentBytes;
        switch (attribute.componentType) {
          case 5126: bytes.writeFloatLE(value, offset); break;
          case 5125: bytes.writeUInt32LE(Math.round(value), offset); break;
          case 5123: bytes.writeUInt16LE(Math.min(65535, Math.max(0, Math.round(value * scale))), offset); break;
          case 5122: bytes.writeInt16LE(Math.min(32767, Math.max(-32767, Math.round(value * scale))), offset); break;
          case 5121: bytes.writeUInt8(Math.min(255, Math.max(0, Math.round(value * scale))), offset); break;
          case 5120: bytes.writeInt8(Math.min(127, Math.max(-127, Math.round(value * scale))), offset); break;
          default: throw new Error(`geometry-lod: cannot write component type ${attribute.componentType}`);
        }
      }
    }
    const view = this.view(bytes, 34962, stride !== elementBytes ? stride : undefined);
    const accessor: Record<string, unknown> = { bufferView: view, componentType: attribute.componentType, count, type: attribute.type };
    if (attribute.normalized) accessor['normalized'] = true;
    if (semantic === 'POSITION') {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < 3; c++) {
          // Bounds of the stored (float32) values.
          const v = Math.fround(attribute.data[i * 3 + c]!);
          min[c] = Math.min(min[c]!, v);
          max[c] = Math.max(max[c]!, v);
        }
      }
      accessor['min'] = count ? min : [0, 0, 0];
      accessor['max'] = count ? max : [0, 0, 0];
    }
    this.json.accessors!.push(accessor as never);
    return this.json.accessors!.length - 1;
  }

  private indices(indices: Uint32Array, vertexCount: number): number {
    const wide = vertexCount > 65535;
    const bytes = Buffer.alloc(indices.length * (wide ? 4 : 2));
    indices.forEach((index, i) => (wide ? bytes.writeUInt32LE(index, i * 4) : bytes.writeUInt16LE(index, i * 2)));
    const view = this.view(bytes, 34963);
    this.json.accessors!.push({ bufferView: view, componentType: wide ? 5125 : 5123, count: indices.length, type: 'SCALAR' } as never);
    return this.json.accessors!.length - 1;
  }

  /** Append a mesh; returns its index. A primitive with no triangles is written as a single degenerate triangle (glTF forbids empty accessors). */
  addMesh(mesh: WriterMesh): number {
    const primitives = mesh.primitives.map((primitive) => {
      let data = primitive.data;
      if (data.indices.length === 0) data = degenerate(data);
      const attributes: Record<string, number> = {};
      const vertexCount = data.attributes.get('POSITION')!.data.length / 3;
      for (const [semantic, attribute] of data.attributes) attributes[semantic] = this.attribute(semantic, attribute);
      return { attributes, indices: this.indices(data.indices, vertexCount), mode: 4, ...(primitive.material !== undefined ? { material: primitive.material } : {}) };
    });
    this.json.meshes!.push({ name: mesh.name, primitives, ...(mesh.extras ? { extras: mesh.extras } : {}) } as never);
    return this.json.meshes!.length - 1;
  }

  addMaterial(material: GltfMaterial): number {
    this.json.materials ??= [];
    this.json.materials.push(material);
    return this.json.materials.length - 1;
  }

  /** A texture with a PNG core source and a KTX2 `KHR_texture_basisu` source (the master's fallback form). */
  addTexture(pngUri: string, ktx2Uri: string | undefined): number {
    this.json.images ??= [];
    this.json.textures ??= [];
    this.json.samplers ??= [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }] as never;
    this.json.images.push({ uri: pngUri, mimeType: 'image/png' });
    const png = this.json.images.length - 1;
    const texture: Record<string, unknown> = { source: png, sampler: 0 };
    if (ktx2Uri) {
      this.json.images.push({ uri: ktx2Uri, mimeType: 'image/ktx2' });
      texture['extensions'] = { KHR_texture_basisu: { source: this.json.images.length - 1 } };
      this.json.extensionsUsed = [...new Set([...(this.json.extensionsUsed ?? []), 'KHR_texture_basisu'])];
    }
    this.json.textures.push(texture as never);
    return this.json.textures.length - 1;
  }

  /** Finish: the JSON (with the buffer declared) and the buffer bytes. */
  finish(): { json: GltfDocument; bin: Buffer } {
    const bin = Buffer.concat(this.chunks);
    this.json.buffers = [{ uri: this.bufferUri, byteLength: bin.byteLength }];
    return { json: this.json, bin };
  }
}

function degenerate(data: PrimitiveData): PrimitiveData {
  const attributes = new Map<string, AttributeData>();
  for (const [semantic, attribute] of data.attributes) {
    const values = new Float32Array(attribute.components);
    if (semantic === 'NORMAL') values[1] = 1;
    if (semantic === 'TANGENT') { values[0] = 1; values[3] = 1; }
    attributes.set(semantic, { ...attribute, data: values });
  }
  return { attributes, indices: new Uint32Array([0, 0, 0]) };
}
