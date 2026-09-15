import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { EvaluationPageClient } from "./EvaluationPageClient";
/**
 * Opt the route out of instant-navigation prerendering.
 *
 * Every route here resolves the app context and the trusted-local session
 * through `connection()`, and the workspace itself holds long-lived client
 * state — the resizable rail, the polled job list, the selection it writes
 * back with `replaceState`. That is precisely the uncached access a prerender
 * refuses, so the route blocks instead, as the scenario workspace does.
 *
 * The flag has to sit on each route rather than on a segment layout: a layout
 * carrying it leaves every page under it still logging
 * `blocking-prerender-dynamic`, which is what put a permanent issue on the
 * Evaluation tab's dev overlay.
 */
export const instant = false;
export default async function EvaluationPage() {
  await connection();
  await requireAppContext("/dashboard/evaluation");
  return <EvaluationPageClient />;
}
