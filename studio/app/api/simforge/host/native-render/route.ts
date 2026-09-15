import { NextResponse } from "next/server";
import { readNativeRenderInstall, startNativeRenderInstall } from "@/app/lib/host/native-render-install";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** Whether the native render runtime is installed here, and install progress. */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(await readNativeRenderInstall(), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}

/** Starts installing the runtime into this machine's runtime root; poll GET for progress. */
export async function POST() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(await startNativeRenderInstall(), { status: 202, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
