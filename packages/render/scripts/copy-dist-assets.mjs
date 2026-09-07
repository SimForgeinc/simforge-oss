import { copyFile, mkdir } from 'node:fs/promises';

// pnpm runs package scripts through cmd.exe on Windows, where `cp` and
// `mkdir -p` are not available; copy the static dist assets with Node instead.
const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const basisSource = new URL('node_modules/three/examples/jsm/libs/basis/', root);
const basisDist = new URL('basis/', dist);

await mkdir(basisDist, { recursive: true });
await copyFile(new URL('harness.html', root), new URL('harness.html', dist));
for (const name of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  await copyFile(new URL(name, basisSource), new URL(name, basisDist));
}
