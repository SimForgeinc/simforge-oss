import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compactState = (state) => {
  if (!state) return undefined;
  const { sourceArtifacts, execution, ...rest } = state;
  return { ...rest, sourceArtifactCount: sourceArtifacts?.length ?? 0 };
};

const actionObject = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const number = { type: 'number' };
const revision = { type: 'integer', minimum: 0 };
const vector3 = { type: 'array', items: number, minItems: 3, maxItems: 3 };
const pixel = actionObject({ u: { type: 'number', minimum: 0, maximum: 1 }, v: { type: 'number', minimum: 0, maximum: 1 } });
const verticalFov = { type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 179 };
/** Diagnostic recipes; these do not attest a participant's policy sensor pixels. */
export const InspectionCameraSchema = { anyOf: [
  actionObject({ kind: { const: 'world' }, eye: vector3, target: vector3, fovYDeg: verticalFov }),
  actionObject({ kind: { const: 'actor-relative' }, actorId: { type: 'string', minLength: 1 },
    offset: vector3, targetOffset: vector3, fovYDeg: verticalFov }),
] };
/** Discoverable request contract for manual camera and geometry operations. */
export const WorkbenchActionSchema = { anyOf: [
  actionObject({ op: { const: 'look' }, mode: { const: 'world' }, frame: { const: 'simforge-y-up' }, eye: vector3, target: vector3,
    fovYDeg: verticalFov }),
  actionObject({ op: { const: 'look' }, mode: { enum: ['home', 'frame-selection'] } }),
  actionObject({ op: { const: 'look' }, mode: { enum: ['orbit', 'pan'] }, dx: number, dy: number }),
  actionObject({ op: { const: 'look' }, mode: { const: 'dolly' }, amount: number }),
  actionObject({ op: { const: 'pick' }, frameRevision: revision, ...pixel.properties }),
  actionObject({ op: { const: 'measure' }, frameRevision: revision, from: pixel, to: pixel }),
  actionObject({ op: { const: 'inspect' }, offset: revision, limit: { type: 'integer', minimum: 1, maximum: 1000 },
    objectIds: { type: 'array', items: { type: 'string', minLength: 1 } } }, ['op']),
  actionObject({ op: { const: 'edit' }, baseRevision: revision, code: { type: 'string', minLength: 1 } }),
  actionObject({ op: { enum: ['undo', 'redo', 'reset'] }, baseRevision: revision }),
  actionObject({ op: { const: 'render' }, engine: { enum: ['cycles', 'eevee'] }, samples: { type: 'integer', minimum: 1, maximum: 4096 } }, ['op']),
] };

/** A local, persistent renderer client. Engine execution is always caller-owned. */
export class BlenderWorkbenchClient {
  constructor({ url = 'http://127.0.0.1:8767' } = {}) {
    this.url = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname) || this.url.protocol !== 'http:') {
      throw new Error('Blender workbench must use a local HTTP URL');
    }
    this.images = new Map();
    this.pending = Promise.resolve();
  }

  async request(path, payload) {
    const response = await fetch(new URL(path, this.url), payload === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error(`Blender HTTP ${response.status}: ${text.slice(0, 1500)}`); }
    if (!response.ok || value.ok === false) {
      throw new Error(`Blender HTTP ${response.status}: ${value.error ?? value.lastError ?? text}`);
    }
    return value;
  }

  async getState() { return this.request('/api/state'); }

  serial(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async action(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Action must be an object');
    if (['edit', 'undo', 'redo', 'reset'].includes(payload.op) && !Number.isInteger(payload.baseRevision)) {
      throw new Error(`${payload.op} requires an explicit baseRevision`);
    }
    if (['pick', 'measure'].includes(payload.op) && !Number.isInteger(payload.frameRevision)) throw new Error(`${payload.op} requires explicit frameRevision`);
    return this.serial(async () => {
      const result = await this.request('/api/action', payload);
      return { ...result, state: compactState(result.state) };
    });
  }

  async bindExecution({ scene, assetBindings, grounding }) {
    const payload = { op: 'bind-execution', scene, assetBindings, grounding };
    return this.serial(async () => {
      const response = await this.request('/api/action', payload);
      if (typeof response.executionId !== 'string') throw new Error('Blender bind returned no executionId');
      return { executionId: response.executionId, cached: response.cached, findings: response.findings };
    });
  }

  async imageForState(state, executionEvidence) {
    if (!state.ready || state.busy) throw new Error('Workbench frame is not stable: loading or busy');
    if (!Array.isArray(state.visualOnlyPatches)) throw new Error('Workbench lacks visual patch provenance; restart with the current source');
    if (!Number.isInteger(state.revision) || !/^[0-9a-f]{64}$/.test(state.frameSha256 ?? '')) {
      throw new Error('Workbench has no digest-bound rendered frame');
    }
    const imageUrl = new URL(state.frameUrl, this.url);
    if (imageUrl.origin !== this.url.origin || imageUrl.pathname !== '/frame.png'
      || imageUrl.searchParams.get('revision') !== String(state.revision)) {
      throw new Error('Frame URL does not match its workbench revision');
    }
    let image = this.images.get(state.frameSha256);
    const imageTransfer = { cacheHit: Boolean(image), frameHttpReadMs: 0, displayPngEncodeMs: 0,
      scope: 'Frame HTTP fetch/hash and display-PNG resize/encode; not GPU readback. Cache hits perform neither operation.' };
    if (!image) {
      const readStarted = performance.now();
      const response = await fetch(imageUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Blender frame HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== state.frameSha256) throw new Error('Frame changed during download; request the current frame again');
      imageTransfer.frameHttpReadMs = performance.now() - readStarted;
      const encodeStarted = performance.now();
      const resized = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 })
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      image = { data: resized.data.toString('base64'), sha256: sha256(resized.data), width: resized.info.width, height: resized.info.height };
      imageTransfer.displayPngEncodeMs = performance.now() - encodeStarted;
      this.images.set(state.frameSha256, image);
      if (this.images.size > 12) this.images.delete(this.images.keys().next().value);
    }
    // /frame.png is mutable: digest alone binds pixels, this second read binds current revision.
    const after = await this.getState();
    if (after.busy || after.revision !== state.revision || after.frameSha256 !== state.frameSha256) {
      throw new Error('Workbench revision changed while obtaining image evidence; retry deliberately');
    }
    const { findings = [], ...execution } = executionEvidence ?? {};
    const evidence = {
      revision: state.revision, sourceImageSha256: state.frameSha256,
      displayedImageSha256: image.sha256, width: image.width, height: image.height,
      engine: state.engine, samples: state.samples, camera: state.camera,
      ditherIntensity: state.ditherIntensity,
      renderMs: state.renderMs, geometryFingerprint: state.geometryFingerprint,
      writeMs: state.writeMs ?? null, device: state.device ?? null,
      persistentData: state.persistentData ?? null, imageTransfer,
      visualOnlyPatches: state.visualOnlyPatches,
      findings, unsupportedCapabilities: state.unsupportedCapabilities ?? [],
      ...(executionEvidence ? { execution } : {}),
    };
    return { content: [{ type: 'text', text: JSON.stringify(evidence) },
      { type: 'image', data: image.data, mimeType: 'image/png' }], evidence };
  }

  async frame() {
    return this.serial(async () => this.imageForState(await this.getState()));
  }

  async renderFrame({ executionId, frameIndex, camera, samples }) {
    return this.serial(async () => {
      const response = await this.request('/api/action', {
        op: 'render-frame', executionId, frameIndex, camera, ...(samples === undefined ? {} : { samples }),
      });
      if (response.evidence?.executionId !== executionId || response.evidence?.frameIndex !== frameIndex) {
        throw new Error('Blender returned evidence for a different execution/frame');
      }
      return this.imageForState(response.state, response.evidence);
    });
  }
}
