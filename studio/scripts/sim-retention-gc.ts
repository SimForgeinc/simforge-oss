/**
 * Simulation retention (studio/app/lib/scenario/sim-retention.ts): delete unreachable draft-cache
 * results older than 90 days, finished simulation requests older than 30 days and editor
 * verification events older than 90 days. Reachability is computed from the product's own rows.
 *
 *   node --conditions=react-server --import tsx studio/scripts/sim-retention-gc.ts            # dry run
 *   node --conditions=react-server --import tsx studio/scripts/sim-retention-gc.ts --apply    # delete
 *
 * Options: --cache-days N, --request-days N, --event-days N, --batch N. On SimCloud run it as the
 * GC role (docs/operations/simulation-retention.md); other principals may not delete the
 * content-addressed objects.
 */
import { shutdownDatabase } from "../app/lib/db/data-api";
import { runSimulationRetention, type RetentionPolicy } from "../app/lib/scenario/sim-retention";

function numberOption(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const policy: Partial<RetentionPolicy> = {
    ...(numberOption("--cache-days") ? { draftCacheDays: numberOption("--cache-days") } : {}),
    ...(numberOption("--request-days") ? { requestDays: numberOption("--request-days") } : {}),
    ...(numberOption("--event-days") ? { verificationEventDays: numberOption("--event-days") } : {}),
    ...(numberOption("--batch") ? { batch: numberOption("--batch") } : {}),
  };
  try {
    const report = await runSimulationRetention({ apply, policy });
    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      policy: report.policy,
      requests: report.requests,
      verificationEvents: report.verificationEvents,
      results: report.results.length,
      timelines: report.timelines,
      objects: report.objects.length,
      sample: report.results.slice(0, 20),
    }, null, 2));
  } finally {
    await shutdownDatabase();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
