/**
 * CI rule: the scenario document contract may only change the way the
 * `scenarioVersion` bump rule allows.
 *
 *   pnpm scenario:contract:check                    # HEAD code vs the committed lock
 *   pnpm scenario:contract:check --base origin/main # ... and vs the lock at the merge base
 *   pnpm scenario:contract:check --write            # refresh the lock (refused on violations)
 *
 * Fails when:
 * - the template schema changed non-additively without a scenarioVersion bump;
 * - an absent-field meaning (SCENARIO_ABSENT_FIELD_SEMANTICS) changed without a bump;
 * - scenarioVersion was bumped without a TypeScript upgrader step from the
 *   previous version, or Rust (SCENARIO_TEMPLATE_VERSION, TEMPLATE_UPGRADE_STEPS)
 *   disagrees with TypeScript;
 * - the committed lock is stale (an additive change, a new registry entry):
 *   refresh it with `--write` so the PR diff shows the change.
 *
 * The comparison against the merge base catches a lock that was edited by
 * hand (or refreshed with a violation) instead of bumping.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUST_TEMPLATE_STEPS_SOURCE,
  RUST_TEMPLATE_VERSION_SOURCE,
  SCENARIO_CONTRACT_LOCK_PATH,
  SCENARIO_CONTRACT_WRITE_COMMAND,
  buildScenarioContract,
  parseRustTemplateContract,
  parseScenarioContractLock,
  scenarioContractViolations,
  serializeScenarioContract,
  type ScenarioContractLock,
} from '../src/contract/contract.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function git(...argv: string[]): string {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function lockAt(ref: string): ScenarioContractLock | null {
  let text: string;
  try {
    text = git('show', `${ref}:${SCENARIO_CONTRACT_LOCK_PATH}`);
  } catch {
    // The lock does not exist at that commit (the base predates the rule).
    return null;
  }
  return parseScenarioContractLock(text, `${ref}:${SCENARIO_CONTRACT_LOCK_PATH}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const baseIndex = args.indexOf('--base');
  const baseRef = baseIndex === -1 ? undefined : args[baseIndex + 1];
  if (baseIndex !== -1 && !baseRef) throw new Error('--base needs a git ref');
  const unknown = args.filter(
    (arg, index) => arg !== '--write' && index !== baseIndex && (baseIndex === -1 || index !== baseIndex + 1),
  );
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(' ')}`);

  const lockPath = join(ROOT, SCENARIO_CONTRACT_LOCK_PATH);
  const current = buildScenarioContract();
  const rust = parseRustTemplateContract(
    readFileSync(join(ROOT, RUST_TEMPLATE_VERSION_SOURCE), 'utf8'),
    readFileSync(join(ROOT, RUST_TEMPLATE_STEPS_SOURCE), 'utf8'),
  );
  const committed = existsSync(lockPath)
    ? parseScenarioContractLock(readFileSync(lockPath, 'utf8'), SCENARIO_CONTRACT_LOCK_PATH)
    : null;
  const head = scenarioContractViolations({ locked: committed, current, rust });

  const violations = [...head.violations];
  let mergeBase: string | null = null;
  let checkedSinceBase = false;
  if (baseRef) {
    // An explicit --base that cannot be resolved is a CI misconfiguration:
    // fail rather than silently checking less.
    mergeBase = git('merge-base', 'HEAD', baseRef);
    const baseLock = lockAt(mergeBase);
    if (baseLock) {
      checkedSinceBase = true;
      const since = scenarioContractViolations({ locked: baseLock, current, rust });
      for (const violation of since.violations) {
        if (!violations.includes(violation)) violations.push(`since ${baseRef} (${mergeBase.slice(0, 12)}): ${violation}`);
      }
    } else {
      process.stdout.write(`scenario contract: ${baseRef} has no ${SCENARIO_CONTRACT_LOCK_PATH} yet; checked against the committed lock only.\n`);
    }
  }

  if (write) {
    if (violations.length > 0) {
      process.stderr.write(`scenario contract: refusing to write the lock; fix these first:\n${violations.map((v) => `  - ${v}`).join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(lockPath, serializeScenarioContract(current));
    process.stdout.write(
      `scenario contract: wrote ${SCENARIO_CONTRACT_LOCK_PATH} (scenarioVersion ${current.scenarioVersion}${head.stale.length > 0 ? `; ${head.stale.length} change(s): ${head.stale.join('; ')}` : '; unchanged'}).\n`,
    );
    return;
  }

  const stale = head.stale.map((reason) => `${reason}; run \`${SCENARIO_CONTRACT_WRITE_COMMAND}\` and commit ${SCENARIO_CONTRACT_LOCK_PATH}`);
  const failures = [...violations, ...stale];
  if (failures.length > 0) {
    process.stderr.write(`scenario contract check FAILED (scenarioVersion ${current.scenarioVersion}):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `scenario contract OK: scenarioVersion ${current.scenarioVersion}, ${current.upgradeSteps.length} upgrade step(s), ${current.absentFieldSemantics.length} absent-field semantics${checkedSinceBase ? `, checked since ${baseRef}` : ''}.\n`,
  );
}

main();
