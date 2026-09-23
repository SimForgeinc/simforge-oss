/**
 * Atomic asset emission for `next dev --webpack`.
 *
 * Webpack writes each emitted asset in place: the file is truncated, then
 * rewritten. Under `next dev` every client recompile (an on-demand page entry
 * added or disposed, an HMR edit) rewrites every chunk that embeds the webpack
 * runtime, because the runtime carries the compilation hash
 * (`__webpack_require__.h`), so the content always differs. A web worker is its
 * own entry chunk with its own runtime, and the scenario playback worker's chunk
 * is ~20 MB with eval source maps. Next serves `/_next/static` straight from
 * disk, so a worker spawned while its chunk is being rewritten downloads a
 * truncated script and dies with `SyntaxError: Invalid or unexpected token`
 * (the unterminated `eval("…")` string where the read stopped). The line
 * changes from one failure to the next; production builds never rewrite a
 * served chunk, which is why only `next dev` is affected.
 *
 * Writing to a sibling temporary file and renaming it over the target makes
 * each emit atomic: a request sees the previous complete chunk or the new
 * complete chunk, never a prefix.
 */

let sequence = 0;

/**
 * Replace `fs.writeFile` with a write-to-temporary-then-rename. `fs` is a
 * webpack `OutputFileSystem` (graceful-fs by default). Idempotent.
 *
 * @param {{ writeFile: Function, rename: Function, unlink?: Function }} fs
 */
export function makeWritesAtomic(fs) {
  if (!fs || fs.__simforgeAtomicWrites || typeof fs.writeFile !== "function" || typeof fs.rename !== "function") {
    return fs;
  }
  const writeFile = fs.writeFile.bind(fs);
  const rename = fs.rename.bind(fs);
  const unlink = typeof fs.unlink === "function" ? fs.unlink.bind(fs) : null;
  fs.writeFile = (file, data, ...rest) => {
    const callback = rest.at(-1);
    if (typeof file !== "string" || typeof callback !== "function") {
      return writeFile(file, data, ...rest);
    }
    const options = rest.slice(0, -1);
    sequence += 1;
    const temporary = `${file}.${process.pid}.${sequence}.tmp`;
    writeFile(temporary, data, ...options, (writeError) => {
      if (writeError) {
        callback(writeError);
        return;
      }
      rename(temporary, file, (renameError) => {
        if (renameError && unlink) unlink(temporary, () => callback(renameError));
        else callback(renameError ?? null);
      });
    });
  };
  Object.defineProperty(fs, "__simforgeAtomicWrites", { value: true });
  return fs;
}

/** Webpack plugin applying {@link makeWritesAtomic} to the compiler's output file system. */
export class AtomicEmitPlugin {
  apply(compiler) {
    // Plugins are applied after the node environment sets `outputFileSystem`;
    // re-check once the environment is final in case anything replaced it.
    makeWritesAtomic(compiler.outputFileSystem);
    compiler.hooks.afterEnvironment.tap("SimforgeAtomicEmit", () => {
      makeWritesAtomic(compiler.outputFileSystem);
    });
  }
}

/**
 * The `next.config` hook: in development, make the browser compiler's emits
 * atomic. Server bundles are not fetched over HTTP and are left alone.
 *
 * @param {{ plugins?: unknown[] }} config webpack configuration
 * @param {{ dev: boolean, isServer: boolean }} context Next's webpack context
 */
export function withAtomicDevEmit(config, { dev, isServer }) {
  if (dev && !isServer) {
    config.plugins = [...(config.plugins ?? []), new AtomicEmitPlugin()];
  }
  return config;
}
