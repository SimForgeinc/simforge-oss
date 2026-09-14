import { connection, NextResponse } from "next/server";
import { listCloudInvitations } from "@/app/lib/cloud/connection";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** `GET /api/simforge/cloud/invitations` -> `{ invitations: StudioCloudInvitation[] }` pending for the account. */
export async function GET(request: Request) {
  await connection();
  try {
    return NextResponse.json(
      { invitations: await listCloudInvitations(request.signal) },
      { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}
