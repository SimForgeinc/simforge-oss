/**
 * Next instrumentation hook: the local host's periodic lease reconciliation.
 *
 * CPU-lane jobs (compile, validate, browser and local native renders) are
 * leased with heartbeats. When the worker dies with the GUI window, its
 * attempt keeps looking active until the lease expires and something reaps
 * it; reaping only ran inside a worker's claim, so a host with no worker left
 * would show a dead render as "running" indefinitely. This sweep keeps the
 * SQL projection truthful whether or not a worker ever comes back.
 */
export async function register(): Promise<void> {
  // Only a long-lived local host runs this timer. On a serverless host (Vercel)
  // a function instance has no lifetime of its own: the interval fires between
  // or inside unrelated invocations, outside any request, where the platform's
  // per-request credentials (x-vercel-oidc-token) do not exist. There it failed
  // every 30 s ("lease.sweep_failed") and was the only thing logged by a render
  // detail request that took ~160 s on dev. Hosted deployments reap CPU leases
  // from their own reconcile cron and worker claims instead.
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build" && !serverless) {
    // Keep the import inside the positive guard: Next's development edge
    // compiler does not prune imports after an early return.
    const { expireCpuAttempts } = await import("./app/lib/scenario/jobs/cpu-control-store");
    const intervalMs = 30_000;
    let sweeping = false;
    const sweep = async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        await expireCpuAttempts();
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          component: "simforge-local-host",
          event: "lease.sweep_failed",
          error: error instanceof Error ? error.message : String(error),
        })}\n`);
      } finally {
        sweeping = false;
      }
    };
    const timer = setInterval(() => void sweep(), intervalMs);
    timer.unref();
  }
}
