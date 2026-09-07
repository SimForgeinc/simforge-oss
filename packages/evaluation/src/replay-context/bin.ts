#!/usr/bin/env node
/**
 * Executable entry for `simforge scene`.
 *
 * Separate from `cli.ts` so the command surface stays importable and testable as a function
 * while this file owns the one side effect a process entry has: setting the exit code the
 * compute worker classifies on.
 */

import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));
