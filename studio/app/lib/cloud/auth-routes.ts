import { NextResponse } from "next/server";
import type { z } from "zod";
import { invalidateUpstreamCatalog } from "@/app/lib/cloud/maps";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { readJson, requireScenarioMutationOrigin, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * The shape every local account mutation route shares: trusted-origin check,
 * a zod-validated JSON body, the connector call, and the connector's error
 * answer. Bodies carry passwords and codes; nothing here logs or echoes them —
 * a validation failure names the fields, never their values.
 */
export async function cloudAuthMutation<S extends z.ZodTypeAny = z.ZodUndefined>(
  request: Request,
  options: {
    body?: S;
    /** The account's map entitlements may have changed; drop the cached upstream catalog. */
    unlocksMaps?: boolean;
  },
  handler: (body: z.output<S>, signal: AbortSignal) => Promise<unknown>,
): Promise<NextResponse> {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  let body = undefined as z.output<S>;
  if (options.body) {
    const parsed = options.body.safeParse(await readJson(request));
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
      return NextResponse.json(
        { error: "invalid_request", message: `Check ${fields.join(", ")}.` },
        { status: 400, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
      );
    }
    body = parsed.data as z.output<S>;
  }
  try {
    const result = await handler(body, request.signal);
    if (options.unlocksMaps) invalidateUpstreamCatalog();
    return NextResponse.json(result, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    return transferErrorResponse(error);
  }
}
