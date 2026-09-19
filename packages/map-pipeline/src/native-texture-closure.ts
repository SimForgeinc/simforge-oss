import { readFile } from 'node:fs/promises';
import type { DerivedClosureInput } from '@simforge-oss/map-registry';
import { sha256 } from './closure.js';

/** Add existing published BC7 bytes to the canonical closure; never generate a second tier. */
export async function composeNativeTextureClosure(master: DerivedClosureInput, web: DerivedClosureInput): Promise<DerivedClosureInput> {
  const members = { ...master.closure.members };
  const files = { ...master.files };
  const include = (memberPath: string, expectedDigest?: string) => {
    const member = web.closure.members[memberPath];
    const file = web.files[memberPath];
    if (!member || !file) throw new Error(`native texture closure missing published member: ${memberPath}`);
    if (expectedDigest !== undefined && member.sha256 !== expectedDigest) throw new Error(`native texture closure digest mismatch: ${memberPath}`);
    members[memberPath] = member;
    files[memberPath] = file;
    return member;
  };
  const readDeclared = async (memberPath: string) => {
    const member = include(memberPath);
    const file = files[memberPath]!;
    const bytes = typeof file === 'string' ? await readFile(file) : Buffer.from(file);
    if (bytes.byteLength !== member.bytes || sha256(bytes) !== member.sha256) throw new Error(`native texture closure corrupt manifest: ${memberPath}`);
    return JSON.parse(bytes.toString('utf8'));
  };
  const source = include('3d/manifest.json');
  const envelope = await readDeclared('3d/variants/manifest.json');
  const entry = envelope.variants?.['textures-512-bc7'];
  if (envelope.sourceManifestSha256 !== source.sha256 || !entry || entry.sourceManifestSha256 !== source.sha256 || typeof entry.file !== 'string' || entry.file.includes('/') || entry.file.includes('\\')) throw new Error('native texture closure invalid BC7 envelope');
  const indexPath = `3d/variants/${entry.file}`;
  include(indexPath, entry.outputSha256);
  const index = await readDeclared(indexPath);
  if (index.id !== 'textures-512-bc7' || index.sourceManifestSha256 !== source.sha256 || !index.images) throw new Error('native texture closure invalid BC7 index');
  for (const image of Object.values(index.images) as Array<{ file: string; outputSha256: string }>) {
    if (!/^variants\/objects\/[a-f0-9]{64}\.ktx2$/.test(image.file)) throw new Error('native texture closure unsafe image path');
    include(`3d/${image.file}`, image.outputSha256);
  }
  return { closure: { ...master.closure, members }, files };
}
