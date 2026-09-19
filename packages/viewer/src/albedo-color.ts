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
  readonly samplePixel = new Uint8Array(4);
  fullPixels = new Uint8Array(0);
  readonly viewport = new Vector4();
  readonly scissor = new Vector4();
  readonly clearColor = new Color();

  constructor() {
    const quad = new Mesh(this.geometry, this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  maskOnly(renderer: WebGLRenderer, texture: Texture, width: number, height: number): boolean {
    const target = renderer.getRenderTarget();
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
    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0, 0);
      renderer.setScissorTest(false);
      const lastLevel = texture.mipmaps.length > 0
        ? texture.mipmaps.length - 1
        : texture.generateMipmaps ? Math.floor(Math.log2(Math.max(width, height))) : 0;
      this.material.uniforms.sourceLevel!.value = lastLevel;
      renderer.setRenderTarget(this.sampleTarget);
      renderer.render(this.scene, this.camera);
      this.samplePixel.fill(0);
      renderer.readRenderTargetPixels(this.sampleTarget, 0, 0, 1, 1, this.samplePixel);
      if (this.samplePixel[3] !== 255) throw new Error('Albedo inspection failed to render its sample');
      if (this.samplePixel[0] !== 0) return false;

      // A few nonzero texels can round down to zero in the final authored mip.
      // It is only a conservative prefilter. NEVER classify from it alone.
      this.fullTarget.setSize(width, height);
      const length = width * height * 4;
      if (this.fullPixels.length < length) this.fullPixels = new Uint8Array(length);
      this.material.uniforms.sourceLevel!.value = 0;
      renderer.setRenderTarget(this.fullTarget);
      renderer.render(this.scene, this.camera);
      this.fullPixels.fill(0, 0, length);
      renderer.readRenderTargetPixels(this.fullTarget, 0, 0, width, height, this.fullPixels);
      for (let offset = 0; offset < length; offset += 4) {
        if (this.fullPixels[offset + 3] !== 255) throw new Error('Albedo inspection failed to render all base texels');
        if (this.fullPixels[offset] !== 0) return false;
      }
      return true;
    } finally {
      this.material.uniforms.sourceMap!.value = null;
      renderer.setRenderTarget(target, cubeFace, mipLevel);
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
  const maskOnly = inspection.maskOnly(renderer, texture, image.width, image.height);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`Albedo inspection failed with WebGL error ${error}`);
  classifications.set(texture.source, maskOnly);
  if (!maskOnly) return;
  const source: unknown = texture.userData.mapTexture?.url;
  const sourceUrl = typeof source === 'string' ? source : null;
  const sourceKey = sourceUrl?.match(/\/([a-f0-9]{64})\.ktx2(?:$|\?)/)?.[1] ?? sourceUrl;
  if (!(sourceKey ? warnedSourceUrls.has(sourceKey) : warnedSources.has(texture.source))) {
    if (sourceKey) warnedSourceUrls.add(sourceKey);
    else warnedSources.add(texture.source);
    console.warn('[map-content-defect] albedo-rgb-missing', {
      texture: texture.name,
      source: sourceUrl,
      width: image.width,
      height: image.height,
      interpretation: 'baseColorFactor RGB with authored texture alpha',
    });
  }
}

export function disposeAlbedoInspection(renderer: WebGLRenderer): void {
  inspections.get(renderer)?.dispose();
  inspections.delete(renderer);
}
