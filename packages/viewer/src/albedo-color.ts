import {
  BufferGeometry,
  Camera,
  Color,
  Float32BufferAttribute,
  GLSL3,
  Mesh,
  NearestFilter,
  NoBlending,
  RawShaderMaterial,
  Scene,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import type { Texture, WebGLRenderer } from 'three';

const albedoSources = new WeakSet<object>();
const classifications = new WeakMap<object, boolean>();
const warnedSources = new WeakSet<object>();
const warnedSourceUrls = new Set<string>();

/** Only immutable map base-colour textures participate; AO/normal/data maps do not. */
export function registerAlbedoTexture(texture: Texture): void {
  albedoSources.add(texture.source);
}

/**
 * Record the ingest classification of a texture (the browser pack's
 * `albedo.rgbMissing`), so the upload never renders and reads it back.
 * An inspection already under way or finished for the source wins.
 */
export function setIngestAlbedoClassification(texture: Texture, rgbMissing: boolean): void {
  if (classifications.has(texture.source)) return;
  classifications.set(texture.source, rgbMissing);
  if (!rgbMissing) return;
  const image = texture.image as { width?: number; height?: number } | undefined;
  warnMaskOnly(texture, image?.width ?? 0, image?.height ?? 0);
}

export function isMaskOnlyAlbedo(texture: Texture | null | undefined): boolean {
  return !!texture && classifications.get(texture.source) === true;
}

class AlbedoInspection {
  readonly scene = new Scene();
  readonly camera = new Camera();
  readonly geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ], 3));
  readonly material = new RawShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { sourceMap: { value: null }, sourceLevel: { value: 0 } },
    vertexShader: `
      precision highp float;
      in vec3 position;
      void main() {
        gl_Position = vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision highp float;
      uniform highp sampler2D sourceMap;
      uniform int sourceLevel;
      out vec4 result;
      void main() {
        vec3 rgb = texelFetch(sourceMap, ivec2(gl_FragCoord.xy), sourceLevel).rgb;
        // Encode a boolean BEFORE RGBA8 readback: even 1/255 sRGB must survive
        // linearization, rather than rounding to zero in an 8-bit target.
        float hasRgb = any(notEqual(rgb, vec3(0.0))) ? 1.0 : 0.0;
        result = vec4(hasRgb, 0.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    toneMapped: false,
  });
  readonly sampleTarget = new WebGLRenderTarget(1, 1, {
    depthBuffer: false, stencilBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter,
  });
  readonly fullTarget = new WebGLRenderTarget(1, 1, {
    depthBuffer: false, stencilBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter,
  });
  readonly viewport = new Vector4();
  readonly scissor = new Vector4();
  readonly clearColor = new Color();

  constructor() {
    const quad = new Mesh(this.geometry, this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /**
   * Render `texture` at `level` into `target` and start an asynchronous
   * readback of it.
   *
   * The readback used to be `readRenderTargetPixels`, a synchronous
   * `glReadPixels` that waits for every queued GPU command — including the
   * texture uploads the paced uploader just issued — once per albedo texture.
   * Profiled on a cold Easterbrook load that stall was the largest single
   * main-thread cost (~1.9 s). `readRenderTargetPixelsAsync` issues the copy
   * into a pixel-pack buffer in the same command stream (so reusing the
   * target afterwards is safe) and resolves on a fence instead.
   */
  #readAsync(renderer: WebGLRenderer, texture: Texture, target: WebGLRenderTarget, level: number,
    width: number, height: number): Promise<Uint8Array> {
    const current = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    renderer.getViewport(this.viewport);
    renderer.getScissor(this.scissor);
    const scissorTest = renderer.getScissorTest();
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    const xr = renderer.xr.enabled;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const shadowNeedsUpdate = renderer.shadowMap.needsUpdate;
    this.material.uniforms.sourceMap!.value = texture;
    this.material.uniforms.sourceLevel!.value = level;
    const pixels = new Uint8Array(width * height * 4);
    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0, 0);
      renderer.setScissorTest(false);
      if (target.width !== width || target.height !== height) target.setSize(width, height);
      renderer.setRenderTarget(target);
      renderer.render(this.scene, this.camera);
      return renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels) as Promise<Uint8Array>;
    } finally {
      this.material.uniforms.sourceMap!.value = null;
      renderer.setRenderTarget(current, cubeFace, mipLevel);
      renderer.setViewport(this.viewport);
      renderer.setScissor(this.scissor);
      renderer.setScissorTest(scissorTest);
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.autoClear = autoClear;
      renderer.xr.enabled = xr;
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      renderer.shadowMap.needsUpdate = shadowNeedsUpdate;
    }
  }

  async maskOnly(renderer: WebGLRenderer, texture: Texture, width: number, height: number,
    disposed: () => boolean): Promise<boolean> {
    const lastLevel = texture.mipmaps.length > 0
      ? texture.mipmaps.length - 1
      : texture.generateMipmaps ? Math.floor(Math.log2(Math.max(width, height))) : 0;
    const sample = await this.#readAsync(renderer, texture, this.sampleTarget, lastLevel, 1, 1);
    if (sample[3] !== 255) throw new Error('Albedo inspection failed to render its sample');
    if (sample[0] !== 0) return false;
    // A few nonzero texels can round down to zero in the final authored mip.
    // It is only a conservative prefilter. NEVER classify from it alone. The
    // texture may have been evicted while the sample was in flight; an
    // unclassified texture keeps the ordinary shader, which is the safe side.
    if (disposed()) return false;
    const full = await this.#readAsync(renderer, texture, this.fullTarget, 0, width, height);
    for (let offset = 0; offset < full.length; offset += 4) {
      if (full[offset + 3] !== 255) throw new Error('Albedo inspection failed to render all base texels');
      if (full[offset] !== 0) return false;
    }
    return true;
  }

  dispose(): void {
    this.sampleTarget.dispose();
    this.fullTarget.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}

const inspections = new WeakMap<WebGLRenderer, AlbedoInspection>();

/** Called only after the paced uploader has made the texture GPU-resident. */
export function inspectAlbedoTexture(renderer: WebGLRenderer, texture: Texture): void {
  if (!albedoSources.has(texture.source)) return;
  if (classifications.has(texture.source)) return;
  const image: unknown = texture.image;
  if (!image || typeof image !== 'object' || !('width' in image) || !('height' in image)
    || typeof image.width !== 'number' || typeof image.height !== 'number'
    || image.width <= 0 || image.height <= 0) return;
  const gl = renderer.getContext();
  const priorErrors: number[] = [];
  for (let code = gl.getError(); code !== gl.NO_ERROR; code = gl.getError()) priorErrors.push(code);
  if (priorErrors.length) {
    // Preserve the failure, but never attribute another GPU operation's error
    // to the texture we have not inspected yet.
    const error = new Error(`Earlier GPU work failed before albedo inspection: WebGL errors ${priorErrors.join(', ')}`);
    error.name = 'PriorWebGLError';
    throw error;
  }
  let inspection = inspections.get(renderer);
  if (!inspection) {
    inspection = new AlbedoInspection();
    inspections.set(renderer, inspection);
  }
  // Classified asynchronously: until the answer arrives the texture keeps the
  // ordinary shader (the answer for nearly every texture). A confirmed
  // mask-only source recompiles the materials that registered for it.
  classifications.set(texture.source, false);
  let disposed = false;
  texture.addEventListener('dispose', () => { disposed = true; });
  const { width, height } = image;
  inspection.maskOnly(renderer, texture, width, height, () => disposed).then((maskOnly) => {
    if (!maskOnly || disposed) return;
    classifications.set(texture.source, true);
    for (const listener of maskOnlyListeners.get(texture.source) ?? []) listener();
    maskOnlyListeners.delete(texture.source);
    warnMaskOnly(texture, width, height);
  }, (error: unknown) => {
    if (disposed) return;
    console.warn('[albedo-inspection] classification failed; keeping the ordinary shader', error);
  });
}

const maskOnlyListeners = new WeakMap<object, Set<() => void>>();

/**
 * Run `listener` if `texture` is later confirmed mask-only. Classification is
 * asynchronous, so a material compiled before the answer must be told to
 * recompile with the mask-only program.
 */
export function onAlbedoMaskOnly(texture: Texture, listener: () => void): void {
  if (classifications.get(texture.source) === true) return;
  let listeners = maskOnlyListeners.get(texture.source);
  if (!listeners) {
    listeners = new Set();
    maskOnlyListeners.set(texture.source, listeners);
  }
  listeners.add(listener);
}

function warnMaskOnly(texture: Texture, width: number, height: number): void {
  const source: unknown = texture.userData.mapTexture?.url;
  const sourceUrl = typeof source === 'string' ? source : null;
  const sourceKey = sourceUrl?.match(/\/([a-f0-9]{64})\.ktx2(?:$|\?)/)?.[1] ?? sourceUrl;
  if (sourceKey ? warnedSourceUrls.has(sourceKey) : warnedSources.has(texture.source)) return;
  if (sourceKey) warnedSourceUrls.add(sourceKey);
  else warnedSources.add(texture.source);
  console.warn('[map-content-defect] albedo-rgb-missing', {
    texture: texture.name,
    source: sourceUrl,
    width,
    height,
    interpretation: 'baseColorFactor RGB with authored texture alpha',
  });
}

export function disposeAlbedoInspection(renderer: WebGLRenderer): void {
  inspections.get(renderer)?.dispose();
  inspections.delete(renderer);
}
