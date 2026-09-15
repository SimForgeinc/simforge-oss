import { connection, NextResponse } from "next/server";
import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { deleteCloudAccount, getCloudAccount, updateCloudAccount } from "@/app/lib/cloud/connection";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/account` -> `StudioCloudAccount` (profile, active organization, devices). */
export async function GET(request: Request) {
  await connection();
  try {
    return NextResponse.json(await getCloudAccount(request.signal), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    return transferErrorResponse(error);
  }
}

const ProfileBody = z.object({ name: z.string().trim().min(1).max(120) });

export function PATCH(request: Request) {
  return cloudAuthMutation(request, { body: ProfileBody }, (body, signal) => updateCloudAccount(body, signal));
}

const DeletionBody = z.object({ password: z.string().min(1).max(256) });

/**
 * `DELETE /api/simforge/cloud/account` -> `StudioCloudAccountDeletion`.
 *
 * Irreversible. The renderer and the CLI send only the typed password; this
 * process holds the session and re-authenticates against the Cloud, which
 * refuses a wrong password without deleting anything. Succeeding clears the
 * local credential, so the account's maps lock in the same breath as sign-out
 * - hence `unlocksMaps`, which drops the cached upstream catalog either way.
 */
export function DELETE(request: Request) {
  return cloudAuthMutation(
    request,
    { body: DeletionBody, unlocksMaps: true },
    (body, signal) => deleteCloudAccount(body, signal),
  );
}
