import { verifyGateway, AUTHOR_MODEL, AUTHOR_EFFORT, GATEWAY_EFFORT } from './gateway.mjs';

// Uses SIMFORGE_GATEWAY (and, for authenticated gateways, SIMFORGE_GATEWAY_TOKEN_FILE).
// Does not start/reconfigure services or choose an alternate model.
const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--output-dir', '--model', '--effort'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i])) {
    console.error('Usage: node experiments/agentic-3d/gateway-probe.mjs [--model anthropic/claude-opus-5] [--effort high|low] [--output-dir DIR]');
    process.exit(1);
  }
  flags.set(args[i], args[i + 1]);
}
try {
  const modelId = flags.get('--model') ?? AUTHOR_MODEL;
  console.log(JSON.stringify(await verifyGateway({ outputDir: flags.get('--output-dir'), modelId, effort: flags.get('--effort') ?? (modelId === AUTHOR_MODEL ? AUTHOR_EFFORT : GATEWAY_EFFORT) }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 1;
}
