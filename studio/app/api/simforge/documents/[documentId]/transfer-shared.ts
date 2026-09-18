import "server-only";

import {
  findSites,
  liftMapBoundTemplate,
  type PortableLiftIssue,
} from "@simforge-oss/compiler/node";
import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type {
  ScenarioTransferOptionsDto,
  TransferDocumentRequest,
} from "@simforge-oss/studio-host";
import type { AppContext } from "@/app/lib/db/app-context";
import { canonicalJsonSha256 } from "@/app/lib/scenario/core";
import {
  type CrossMapVariationTransferReceiptInput,
  listScenarioMapDescriptors,
} from "@/app/lib/scenario/document-store";
import { loadCollisionDraftMap } from "@/app/lib/scenario/collision-draft-map.server";
import type { ScenarioDocumentDto, ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";

const MAX_SITES_PER_MAP = 8;

function issueDto(issue: PortableLiftIssue) {
  return {
    code: issue.code,
    severity: issue.severity,
    ...(issue.path === undefined ? {} : { path: issue.path }),
    message: issue.message,
  };
}

async function sourceLift(
  context: AppContext,
  source: ScenarioDocumentDto,
  descriptors: readonly ScenarioMapDescriptorDto[],
) {
  const descriptor = descriptors.find((candidate) => candidate.mapVersionId === source.mapVersionId);
  if (!descriptor) return null;
  const binding = await loadCollisionDraftMap(context, descriptor.sourceMapId);
  if (binding.mapVersionId !== descriptor.mapVersionId) return null;
  return { descriptor, binding, result: liftMapBoundTemplate(source.content, binding.bundle) };
}

export async function transferOptions(
  context: AppContext,
  source: ScenarioDocumentDto,
  targetMapVersionIds?: readonly string[],
): Promise<ScenarioTransferOptionsDto> {
  const descriptors = await listScenarioMapDescriptors(context);
  const lifted = await sourceLift(context, source, descriptors);
  if (!lifted) {
    return {
      sourceMapVersionId: source.mapVersionId,
      sourceSiteId: null,
      lift: {
        ok: false,
        issues: [{
          code: "source_map_unavailable",
          severity: "error",
          message: "The source map version is not available in the published map catalog.",
        }],
      },
      maps: [],
    };
  }

  const issues = lifted.result.issues.map(issueDto);
  if (!lifted.result.template) {
    return {
      sourceMapVersionId: source.mapVersionId,
      sourceSiteId: lifted.result.sourceSiteId,
      lift: { ok: false, issues },
      maps: [],
    };
  }

  const requested = targetMapVersionIds ? new Set(targetMapVersionIds) : null;
  const targets = descriptors.filter((descriptor) =>
    descriptor.mapVersionId !== source.mapVersionId
    && (!requested || requested.has(descriptor.mapVersionId))
  );
  const maps = await Promise.all(targets.map(async (descriptor) => {
    const binding = await loadCollisionDraftMap(context, descriptor.sourceMapId);
    return {
      mapVersionId: descriptor.mapVersionId,
      sourceMapId: descriptor.sourceMapId,
      label: descriptor.label,
      locality: descriptor.locality,
      siteIds: findSites(lifted.result.template!, binding.bundle).slice(0, MAX_SITES_PER_MAP),
    };
  }));
  return {
    sourceMapVersionId: source.mapVersionId,
    sourceSiteId: lifted.result.sourceSiteId,
    lift: { ok: true, issues },
    maps,
  };
}

export async function prepareTransfer(
  context: AppContext,
  source: ScenarioDocumentDto,
  input: TransferDocumentRequest,
): Promise<{
  content: ScenarioTemplateV2;
  receipt: CrossMapVariationTransferReceiptInput;
} | null> {
  const descriptors = await listScenarioMapDescriptors(context);
  const target = descriptors.find((candidate) => candidate.mapVersionId === input.targetMapVersionId);
  if (!target || target.mapVersionId === source.mapVersionId) return null;
  const lifted = await sourceLift(context, source, descriptors);
  if (!lifted?.result.template || !lifted.result.sourceSiteId) return null;

  const targetBinding = await loadCollisionDraftMap(context, target.sourceMapId);
  const siteIds = findSites(lifted.result.template, targetBinding.bundle).slice(0, MAX_SITES_PER_MAP);
  if (!siteIds.includes(input.siteId)) return null;

  const portable = lifted.result.template;
  const content = parseTemplate({
    ...portable,
    sourceMap: { mapId: target.sourceMapId, mapName: target.label },
    anchor: {
      ...portable.anchor,
      pin: {
        mapId: target.sourceMapId,
        siteId: input.siteId,
        topologyDigest: targetBinding.bundle.digest,
      },
    },
    ...(input.signalPlanDecision === "remove" ? { mapSignalPlans: [] } : {}),
  });
  const patternSha256 = canonicalJsonSha256(portable.anchor);
  const issues = lifted.result.issues.map(issueDto);
  return {
    content,
    receipt: {
      patternId: `portable:${patternSha256.slice(0, 55)}`,
      patternSha256,
      sourceSiteId: lifted.result.sourceSiteId,
      targetSiteId: input.siteId,
      permutationKey: null,
      verdict: "review",
      acceptance: "pending_validation",
      equivalenceScore: 0,
      topologyScore: null,
      roleBindingScore: null,
      intentPreserved: false,
      issues,
      resumeToken: null,
      sourceTopologyDigest: lifted.binding.bundle.digest,
      targetTopologyDigest: targetBinding.bundle.digest,
      sourceClosureDigest: lifted.descriptor.browserClosureSha256,
      targetClosureDigest: target.browserClosureSha256,
      compilerVersion: null,
      matcherVersion: null,
      solverVersion: null,
      paramSeed: null,
      drawIndex: null,
      inputHash: null,
      replayKey: null,
      replayToken: null,
      transferVerdict: null,
      geometryTransfer: null,
      behaviorPreservation: "unmeasured",
      behaviorMetrics: null,
      requiredChecksPassed: null,
      identityProvenance: "portable-lift:pending-validation",
    },
  };
}
