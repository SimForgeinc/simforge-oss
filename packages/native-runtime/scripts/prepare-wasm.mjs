import { readFile, writeFile } from 'node:fs/promises';

const glueFile = new URL('../wasm/simforge_native_runtime.js', import.meta.url);
const generatedUrl = "new URL('simforge_native_runtime_bg.wasm', import.meta.url)";
const relativeUrl = "new URL('./simforge_native_runtime_bg.wasm', import.meta.url)";
const source = (await readFile(glueFile, 'utf8')).replace(generatedUrl, relativeUrl);
if (!source.includes(relativeUrl)) {
  throw new Error('wasm-bindgen changed its asset URL; review the generated browser module before publishing');
}
// Keep the glue beside its binary. Webpack must resolve this as a relative
// asset, not a bare package, even when callers supply their own init source.
await writeFile(glueFile, source);
// wasm-pack writes a wildcard .gitignore; it must not hide published assets.
await writeFile(new URL('../wasm/.npmignore', import.meta.url), '');
