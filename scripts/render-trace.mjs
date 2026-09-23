#!/usr/bin/env node
/**
 * Deterministic top-down trace renderer: a thin wrapper over
 * `@simforge-oss/trace-render` (tools/trace-render), which the renderer was
 * promoted into. Same flags, same artifacts, same manifest.
 *
 *   node scripts/render-trace.mjs --instance <instance.json> --trace <trace.json.gz> --out <dir> [--camera follow-ego] [--fps 12] ...
 */
import { runTraceRenderCli } from '../tools/trace-render/src/index.mjs';

runTraceRenderCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
