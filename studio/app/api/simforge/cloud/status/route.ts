import { connection, NextResponse } from "next/server";
import { getCloudStatus } from "@/app/lib/cloud/connection";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

export async function GET() {
  await connection();
  try {
    return NextResponse.json(await getCloudStatus(), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    // A cloud host has no connector (404); anything else is a real server error.
    return transferErrorResponse(error);
  }
}
