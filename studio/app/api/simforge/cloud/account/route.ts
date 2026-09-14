import { connection, NextResponse } from "next/server";
import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { getCloudAccount, updateCloudAccount } from "@/app/lib/cloud/connection";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/account` -> `StudioCloudAccount` (profile, active workspace, devices). */
export async function GET(request: Request) {
  await connection();
  try {
    return NextResponse.json(await getCloudAccount(request.signal), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    return transferErrorResponse(error);
  }
}

const Body = z.object({ name: z.string().trim().min(1).max(120) });

export function PATCH(request: Request) {
  return cloudAuthMutation(request, { body: Body }, (body, signal) => updateCloudAccount(body, signal));
}
