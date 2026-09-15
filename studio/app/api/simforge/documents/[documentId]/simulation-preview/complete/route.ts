import { NextResponse } from "next/server";
import { CompleteScenarioSimulationPreviewSchema } from "@/app/lib/scenario/contracts";
import { completeSimulationPreview } from "@/app/lib/scenario/simulation-preview-store";
import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext } from "@/app/lib/scenario/http";
type Context = { params: Promise<{ documentId: string }> };
