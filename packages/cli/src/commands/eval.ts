import os from 'node:os';
import path from 'node:path';
import { discoverPanelIds, promotePolicy } from '@simforge-oss/evaluation';
import { boolFlag, listFlag, optionalString, parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';
import { runDrive } from './drive/index.js';
import { repositoryRoot } from './drive/model-socket.js';
import { safeRunId } from './drive/run-dir.js';
import { compose } from './drive/compose.js';

export async function evalCommand(argv: readonly string[]): Promise<number> {
  if (argv[0] !== 'promote') throw new CliError('unknown_command', 'simforge eval promote <torch-ref|policy-id> --split test [--panel <id>]');
  const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: ['split', 'panel', 'out', 'comparisons', 'bc-baseline', 'quant', 'render-binary'] });
  const policy = args.positionals[0];
  if (!policy || args.positionals.length !== 1) throw new CliError('missing_argument', 'eval promote needs one torch ref or policy id');
  if ((optionalString(args, 'split') ?? 'test') !== 'test') throw new CliError('bad_value', 'promotion requires the frozen held-out test split; training/validation are forbidden');
  const requestedPanel = optionalString(args, 'panel') ?? 'canary8';
  const panel = requestedPanel === 'canary' ? 'canary8' : requestedPanel === 'devpanel' ? 'devpanel32' : requestedPanel;
  const panelDirectory = path.join(repositoryRoot(), 'qualification/panels');
  const availablePanels = await discoverPanelIds(panelDirectory);
  if (!availablePanels.includes(panel)) throw new CliError('bad_value', `unknown panel ${panel}; available: ${availablePanels.join(', ')}`, { path: '--panel', detail: { known: availablePanels } });
  const out = optionalString(args, 'out') ?? path.join(os.homedir(), 'simforge-assets/runs/drive/training/promotions', `${policy.replace(/[^a-zA-Z0-9_.-]/g, '_')}__${panel}`);
  const report = await promotePolicy({
    policy, out, panelFile: path.join(panelDirectory, `${panel}.panel.json`),
    comparisons: listFlag(args, 'comparisons') ?? ['auto-e2e'], bcBaseline: optionalString(args, 'bc-baseline'),
    log: (line) => process.stdout.write(`[promote] ${line}\n`),
    async run(request) {
      await runDrive({ scenario: request.scenario, policy: request.policy, seed: request.entry.seed, duration: request.entry.durationS, out: request.out, live: false, realtime: false, deadlineMs: null, noStartModel: false, noStartRenderer: false, quant: optionalString(args, 'quant') ?? 'nf4', renderBinary: optionalString(args, 'render-binary'), pretty: false, replanHz: request.panel.timing.replanHz, warmupFrames: request.panel.timing.warmupFrames, alpasimStyleScore: true });
      return path.join(request.out, safeRunId(request.entry.id, request.policy.startsWith('torch:') ? 'torch' : request.policy, request.entry.seed));
    },
  });
  const first = report.panel.entries.find((e) => e.source === 'test');
  const panes = first ? report.comparison.flatMap((p) => {
    const episode = p.episodes.find((e) => e.entryId === first.id);
    return episode?.health.healthy && episode.runDir ? [episode.runDir] : [];
  }) : [];
  if (panes.length >= 2) await compose({ runDirs: panes, out: path.join(out, 'heat', 'heat.mp4'), emitResult: false });
  emit({ ok: true, promotion: path.join(path.resolve(out), 'promotion.json'), verdict: report.verdict, reasons: report.reasons, comparison: report.comparison.map(({ episodes: _episodes, ...row }) => row) }, { pretty: boolFlag(args, 'pretty') });
  // A completed gate is successful execution even when evidence correctly refuses promotion.
  return EXIT.ok;
}
