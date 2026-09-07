#!/usr/bin/env node
// Certify (or refuse) the third-party payload of a SimForge Studio installer
// set.
//
//   node scripts/release/audit-bundled-licenses.mjs [--out <dir>] [--json]
//   node scripts/release/audit-bundled-licenses.mjs --platforms linux-x64,windows-x64
//
// Writes the audit receipt (simforge.desktop-license-audit/v1) and the
// THIRD_PARTY_NOTICES.md a public download must carry. Exit code 2 means at
// least one platform is not cleared for public redistribution — that is a
// finding to act on, not a warning to pass.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditBundledComponents, loadLedger, renderThirdPartyNotices, verifyEncoderReceipts } from "./third-party-audit-lib.mjs";
import { NOTICES_FILE } from "./desktop-release-lib.mjs";

export const AUDIT_FILE = "license-audit.json";

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[arg.slice(2)] = true;
    else {
      args[arg.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const platforms = typeof args.platforms === "string" ? args.platforms.split(",").map((entry) => entry.trim()) : undefined;
  // Encoder-build receipts, verified against the source pins and the bytes on
  // disk. There is deliberately no way to assert accompaniment by naming a
  // platform: the archive and its build manifest have to be there.
  const encoderReceipts = typeof args["encoder-receipts"] === "string"
    ? await verifyEncoderReceipts({ repoRoot, dir: resolve(args["encoder-receipts"]) })
    : null;
  const receipt = await auditBundledComponents({ repoRoot, platforms, encoderReceipts });
  const { components } = await loadLedger(repoRoot);
  const notices = renderThirdPartyNotices({ receipt, components });

  if (typeof args.out === "string") {
    await mkdir(args.out, { recursive: true });
    await writeFile(join(args.out, AUDIT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);
    await writeFile(join(args.out, NOTICES_FILE), notices);
  }

  if (args.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else {
    for (const [platform, verdict] of Object.entries(receipt.platforms)) {
      const state = /** @type {any} */ (verdict);
      process.stdout.write(`${state.redistribution === "cleared" ? "CLEARED" : "BLOCKED"}  ${platform}\n`);
      for (const reason of state.blockedBy) process.stdout.write(`         ${reason}\n`);
    }
    for (const problem of receipt.encoders.receiptProblems) {
      process.stdout.write(`RECEIPT  ${problem}\n`);
    }
    for (const drift of receipt.sourceDrift) {
      process.stdout.write(`DRIFT    ${drift.source}: ledger ${drift.ledger} vs lock ${drift.lock}\n`);
    }
    process.stdout.write(`\npublic redistribution: ${receipt.publicRedistribution}\n`);
  }
  process.exit(receipt.publicRedistribution === "cleared" ? 0 : 2);
}
