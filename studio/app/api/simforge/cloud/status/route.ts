import { connection, NextResponse } from "next/server";
import { getCloudStatus } from "@/app/lib/cloud/connection";
import { SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

export async function GET() {
  await connection();
  return NextResponse.json(await getCloudStatus(), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
