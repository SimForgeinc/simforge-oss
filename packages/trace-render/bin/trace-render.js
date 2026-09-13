#!/usr/bin/env node

import { runTraceRenderCli } from '../src/index.mjs';

runTraceRenderCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
