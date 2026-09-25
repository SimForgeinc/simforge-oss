import { Document } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { repairVertexFrames, VertexFrameError } from '../src/vertex-frames.js';

/** Two triangles of a unit quad in the XZ plane (normal +Y), UVs along +X / +Z. */
function quad(normals: number[], tangents: number[], uvs = [0, 0, 1, 0, 1, 1, 0, 1]) {
  const document = new Document();
  const buffer = document.createBuffer();
  const acc = (type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR', array: Float32Array | Uint16Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(normals)))
    .setAttribute('TANGENT', acc('VEC4', new Float32Array(tangents)))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uvs)))
    .setIndices(acc('SCALAR', new Uint16Array([0, 2, 1, 0, 3, 2])));
  document.createMesh('road').addPrimitive(primitive);
  return { document, primitive };
}
const up = [0, 1, 0];
const along = [1, 0, 0, 1];

describe('vertex frame repair', () => {
  it('replaces zero normals with the area-weighted face normal and zero tangents with the UV tangent', () => {
    const { document, primitive } = quad([...up, 0, 0, 0, ...up, ...up], [...along, ...along, 0, 0, 0, 1, ...along]);
    const report = repairVertexFrames(document);
    expect(report).toMatchObject({ normals: 1, tangents: 1, tangentsArbitrary: 0, normalsUndrawn: 0, byMesh: { road: { normals: 1, tangents: 1 } } });
    const n = primitive.getAttribute('NORMAL')!.getElement(1, []);
    expect(n.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 1, 0]);
    const t = primitive.getAttribute('TANGENT')!.getElement(2, []);
    expect(t.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([1, 0, 0, 1]);
    // Valid vertices are untouched.
    expect(primitive.getAttribute('NORMAL')!.getElement(0, [])).toEqual(up);
  });

  it('gives degenerate-UV vertices a unit tangent orthogonal to the normal, and counts it', () => {
    const { document, primitive } = quad([...up, ...up, ...up, ...up], [0, 0, 0, 1, ...along, ...along, ...along], [0, 0, 0, 0, 0, 0, 0, 0]);
    const report = repairVertexFrames(document);
    expect(report).toMatchObject({ tangents: 1, tangentsArbitrary: 1 });
    const t = primitive.getAttribute('TANGENT')!.getElement(0, []);
    expect(Math.hypot(t[0]!, t[1]!, t[2]!)).toBeCloseTo(1, 6);
    expect(t[1]).toBeCloseTo(0, 6);
  });

  it('refuses a drawn vertex whose face normals cancel', () => {
    // A vertex shared by a triangle and its mirror image (opposite winding).
    const document = new Document();
    const buffer = document.createBuffer();
    const acc = (type: 'VEC3' | 'SCALAR', array: Float32Array | Uint16Array) => document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const primitive = document.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])))
      .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 0, 0, 1, 0, 0, 1, 0])))
      .setIndices(acc('SCALAR', new Uint16Array([0, 2, 1, 0, 1, 2])));
    document.createMesh('fold').addPrimitive(primitive);
    expect(() => repairVertexFrames(document)).toThrow(VertexFrameError);
  });
});
