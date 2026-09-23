import { connection } from "next/server";
import { publicRuntimeConfig, publicRuntimeConfigScript } from "@/app/lib/public-env";

/**
 * `/runtime-config.js`: the deployment's public settings as a classic script,
 * read from the environment on every request (never prerendered), so one build
 * serves every environment. Loaded by the root layout before app code.
 */
export async function GET(): Promise<Response> {
  await connection();
  return new Response(publicRuntimeConfigScript(publicRuntimeConfig()), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
