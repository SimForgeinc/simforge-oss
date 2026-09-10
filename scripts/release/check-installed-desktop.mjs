import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readInstalledHostRecord, runInstalledConnectionChecks } from './installed-connection-checks.mjs';
import { runInstalledMapChecks } from './installed-map-checks.mjs';

const { values } = parseArgs({ options: {
  'data-root': { type: 'string' },
  out: { type: 'string' },
  'allow-map-download': { type: 'boolean', default: false },
  'expected-version': { type: 'string' },
  'timeout-ms': { type: 'string', default: '1800000' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node check-installed-desktop.mjs --data-root <installed Studio data directory> --out <report.json> [--allow-map-download] [--expected-version <version>] [--timeout-ms <milliseconds>]\nReads credentials privately from host.json. Downloads only public Richmond Field Station when explicitly authorized. Never clears caches or changes connections. Exit 0: all checks passed; 1: failed; 2: blocked coverage remains.');
} else {
  if (!values['data-root'] || !values.out) throw new Error('--data-root and --out are required');
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  const dataRoot = resolve(values['data-root']);
  const report = {
    schema: 'simforge.installed-desktop-integration/v1',
    startedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    dataRoot,
    allowMapDownload: values['allow-map-download'],
    checks: [],
  };
  try {
    const state = await readInstalledHostRecord(dataRoot);
    const origin = new URL(state.baseUrl);
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Host record must identify an uncredentialed loopback HTTP origin');
    if (typeof state.controlToken !== 'string' || !state.controlToken) throw new Error('Host record has no control credential');
    const options = {
      baseUrl: origin.origin,
      headers: { authorization: `Bearer ${state.controlToken}` },
      dataRoot,
      signal: AbortSignal.timeout(timeoutMs),
      expectedVersion: values['expected-version'],
    };
    report.baseUrl = origin.origin;
    report.checks.push(...await runInstalledConnectionChecks(options));
    report.checks.push(...await runInstalledMapChecks({ ...options, timeoutMs, allowMapDownload: values['allow-map-download'] }));
  } catch {
    report.checks.push({ name: 'integration-runner', status: 'failed', error: 'Unable to complete installed-host qualification; credentials and untrusted error text withheld.' });
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.checks.some(check => check.status === 'failed') ? 'failed' : report.checks.some(check => check.status === 'blocked') ? 'blocked' : 'passed';
  await writeFile(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, report: resolve(values.out), checks: report.checks.map(({ name, status }) => ({ name, status })) }, null, 2));
  process.exitCode = report.status === 'failed' ? 1 : report.status === 'blocked' ? 2 : 0;
}
