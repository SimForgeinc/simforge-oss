import { NextResponse } from "next/server";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { readRunDirectory, resolveRunDirectory } from "@/app/lib/evaluation/run-directory";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  try {
    const directory = await resolveRunDirectory(auth.context, new URL(request.url).searchParams.get("ref") ?? "");
    return NextResponse.json(await readRunDirectory(directory), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
