import { access, opendir, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

if (process.argv.length !== 4) {
  throw new Error('Usage: finalize-deploy.mjs <deployed-package> <source-package>');
}
const destination = await realpath(process.argv[2]);
const source = await realpath(process.argv[3]);
if (destination === source || source.startsWith(`${destination}${path.sep}`) || destination.startsWith(`${source}${path.sep}`)) {
  throw new Error('deployment and source must be separate directories');
}
const deployedPackage = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'));
const sourcePackage = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
if (deployedPackage.name !== sourcePackage.name || deployedPackage.version !== sourcePackage.version) {
  throw new Error('deployment does not identify the source package');
}
// The image entrypoint and every declared runtime dependency must be inside
// the closure; a deploy that resolved but shipped nothing runnable fails here,
// not at container start.
const required = ['dist/main.js', ...Object.keys(sourcePackage.dependencies ?? {}).map((name) => path.join('node_modules', name, 'package.json'))];
for (const relative of required) {
  await access(path.join(destination, relative)).catch(() => { throw new Error(`deployment lacks ${relative}`); });
}
let links = 0;
let rebased = 0;
async function visit(directory) {
  for await (const entry of await opendir(directory)) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(file);
    } else if (entry.isSymbolicLink()) {
      const target = await realpath(file);
      if (target !== destination && !target.startsWith(`${destination}${path.sep}`)) {
        if (target !== source) throw new Error(`deployment link escapes its closure: ${file} -> ${target}`);
        // pnpm's workspace deploy can retain the package's own workspace link.
        // A shipped closure must refer to itself, never to the build checkout.
        await unlink(file);
        await symlink(path.relative(path.dirname(file), destination), file, 'dir');
        rebased += 1;
      }
      links += 1;
    }
  }
}
await visit(destination);
console.log(JSON.stringify({ package: deployedPackage.name, destination, links, selfLinksRebased: rebased }));
