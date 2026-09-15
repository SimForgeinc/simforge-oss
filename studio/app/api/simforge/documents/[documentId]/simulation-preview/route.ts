import { NextResponse } from "next/server";
import { ReserveScenarioSimulationPreviewSchema } from "@/app/lib/scenario/contracts";
import { getCurrentSimulationPreview, reserveSimulationPreview } from "@/app/lib/scenario/simulation-preview-store";
import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
type Context = { params: Promise<{ documentId: string }> };
export async function GET(_request: Request, route: Context) { const auth=await requireScenarioContext(); if(auth.response)return auth.response; const {documentId}=await route.params; const value=await getCurrentSimulationPreview(auth.context,documentId); return value?NextResponse.json(value,{headers:SCENARIO_PRIVATE_CACHE_HEADERS}):NextResponse.json({error:"simulation_preview_not_found"},{status:404}); }
