import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RenderInputFile } from '../engine.js';
import { collectNativeMapMembers, nativeMapMemberInputId } from './map-closure.js';
import { NativeTextureCapacityError, stageNativeTextureProfile } from './texture-profile.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'native-texture-profile-'));
  directories.push(directory);
  const inputs: RenderInputFile[] = [];
  const add = async (relativePath: string, bytes: Buffer | string) => {
    const file = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    const input = { inputId: nativeMapMemberInputId(relativePath), relativePath, path: file, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: Buffer.byteLength(bytes) };
    inputs.push(input);
    return input;
  };
  // Preflight reads the KTX2 header only; these aren't upload/render fixtures.
  const header = (size: number, format: number) => {
    const bytes = Buffer.alloc(80);
    Buffer.from([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a]).copy(bytes);
    bytes.writeUInt32LE(format, 12); bytes.writeUInt32LE(size,20); bytes.writeUInt32LE(size,24); bytes.writeUInt32LE(1,36); bytes.writeUInt32LE(1,40);
    return bytes;
  };
  const original = JSON.stringify({buffers:[{uri:'geometry.bin',byteLength:16}],images:[{uri:'images/not-installed.jpg'},{uri:'images/full.ktx2'}],textures:[{source:0,extensions:{KHR_texture_basisu:{source:1}}}]});
  await add('master.gltf', original);
  await add('geometry.bin', Buffer.alloc(16));
  await add('images/full.ktx2', header(1024,0));
  const manifest = await add('3d/manifest.json', '{}');
  const image = await add('3d/variants/objects/bc7.ktx2',header(512,145));
  const index = await add('3d/variants/bc7.json',JSON.stringify({schemaVersion:1,id:'textures-512-bc7',sourceManifestSha256:manifest.sha256,images:{'../images/full.ktx2':{file:'variants/objects/bc7.ktx2',outputSha256:image.sha256,width:512,height:512,codec:'bc7'}}}));
  await add('3d/variants/manifest.json',JSON.stringify({sourceManifestSha256:manifest.sha256,variants:{'textures-512-bc7':{file:'bc7.json',outputSha256:index.sha256,sourceManifestSha256:manifest.sha256}}}));
  return {directory,original,closure:collectNativeMapMembers(inputs),cacheDirectory:path.join(directory,'cache')};
}

it('selects the Basis source, pins BC7 independently, and leaves the installed master unchanged', async () => {
  const value = await fixture();
  const full = await stageNativeTextureProfile({...value,renderTextures:'uastc-full',framePixels:640*480,capacityBytes:16*1024**3});
  const ml = await stageNativeTextureProfile({...value,renderTextures:'bc7-512',framePixels:640*480,capacityBytes:16*1024**3});
  expect(full.textureBytes).toBe(1024**2);
  expect(ml.textureBytes).toBe(512**2);
  expect(ml.budgetBytes).toBe(ml.estimatedBytes);
  expect(JSON.parse(await fs.readFile(ml.masterPath,'utf8')).images[1].uri).toBe('3d/variants/objects/bc7.ktx2');
  expect(await fs.readFile(path.join(value.directory,'master.gltf'),'utf8')).toBe(value.original);
  expect(await fs.readFile(full.masterPath,'utf8')).toBe(value.original);
});

it('refuses a pinned capacity before staging and exposes demand, capacity and the override', async () => {
  const value = await fixture();
  try {
    await stageNativeTextureProfile({...value,renderTextures:'bc7-512',framePixels:1920*1080,capacityBytes:1});
    throw new Error('capacity was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(NativeTextureCapacityError);
    expect(error).toMatchObject({budgetBytes:1,capacitySource:'assumed',demandBytes:512**2+32+1920*1080*64+512*1024**2});
    expect((error as Error).message).toContain('nativeVramBudgetBytes');
  }
  await expect(fs.stat(value.cacheDirectory)).rejects.toMatchObject({code:'ENOENT'});
});

it('reuses an immutable disk cache across simultaneous environments without partial master files', async () => {
  const value = await fixture();
  const results = await Promise.all([0,1].map(() => stageNativeTextureProfile({...value,renderTextures:'bc7-512',framePixels:1280*720,capacityBytes:16*1024**3})));
  expect(results[0]!.masterPath).toBe(results[1]!.masterPath);
  expect(JSON.parse(await fs.readFile(results[0]!.masterPath,'utf8')).buffers[0].uri).toBe('geometry.bin');
  expect(await fs.readFile(path.join(path.dirname(results[0]!.masterPath),'geometry.bin'))).toEqual(Buffer.alloc(16));
});
