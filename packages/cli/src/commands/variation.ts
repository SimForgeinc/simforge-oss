/**
 * `simforge variation fork` and `simforge variation transfer`.
 *
 * A fork creates one child from an already portable template. A transfer first
 * lifts a map-bound template into portable roles, then binds it to a target
 * site. Neither operation mutates the source.
 */
import path from 'node:path';

import { contentHash, type SimTrace } from '@simforge-oss/engine';
import { runSimulation } from '@simforge-oss/engine/node';
import {
  compileTemplate,
  findSite,
  liftMapBoundTemplate,
  loadMap,
  readTemplate,
  writeJsonFile,
  writeTraceFile,
} from '@simforge-oss/compiler/node';
import type { ScenarioTemplateV2 } from '@simforge-oss/scenario';

import { EXIT, CliError } from '../errors.js';
import { emit, emitLines } from '../output.js';
import { instanceFile } from './instantiate.js';

export interface VariationForkOptions {
  readonly file: string;
  readonly mapId: string;
  readonly siteId: string;
  readonly seed?: string | undefined;
  readonly draw?: number | undefined;
  readonly out: string;
  readonly pretty: boolean;
}

export interface ScenarioVariationFile {
  readonly kind: 'scenario-variation';
  readonly version: 1;
  readonly lineage: {
    readonly sourceTemplate: string;
    readonly sourceTemplateDigest: string;
    readonly sourceMapId?: string;
    readonly sourceTopologyDigest?: string;
    readonly targetMapId: string;
    readonly targetSiteId: string;
    readonly targetTopologyDigest?: string;
    readonly paramSeed: string;
    readonly drawIndex: number;
    readonly liftIssues?: readonly { code: string; severity: string; path?: string; message: string }[];
  };
  readonly instance: 'instance.json';
  readonly trace: 'trace.json.gz';
}

export async function variationFork(options: VariationForkOptions): Promise<number> {
  const template = await readTemplate(options.file);
  assertPortable(template);
  const { bundle, site } = await findSite(template, options.mapId, options.siteId);
  const product = compileTemplate(template, bundle, site, materializeOptions(options));
  if (!product.manifest.feasible) {
    throw new CliError('variation_infeasible', 'target variation did not materialize feasibly', {
      path: options.siteId,
      detail: { issues: product.manifest.issues },
      exitCode: EXIT.validationFindings,
    });
  }
  const trace: SimTrace = runSimulation(product.input, { graph: bundle.graph }).trace;
  const variation: ScenarioVariationFile = {
    kind: 'scenario-variation',
    version: 1,
    lineage: {
      sourceTemplate: path.resolve(options.file),
      sourceTemplateDigest: contentHash(template),
      targetMapId: options.mapId,
      targetSiteId: options.siteId,
      paramSeed: product.manifest.replayKey.paramSeed,
      drawIndex: product.manifest.replayKey.drawIndex,
    },
    instance: 'instance.json',
    trace: 'trace.json.gz',
  };
  await writeVariation(options.out, variation, product, trace);
  report(options, variation, template.meta.name, product.manifest.inputHash);
  return EXIT.ok;
}

export interface VariationTransferOptions {
  readonly file: string;
  readonly sourceMapId: string;
  readonly targetMapId: string;
  readonly siteId: string;
  readonly seed?: string | undefined;
  readonly draw?: number | undefined;
  readonly out: string;
  readonly pretty: boolean;
}

export async function variationTransfer(options: VariationTransferOptions): Promise<number> {
  const sourceTemplate = await readTemplate(options.file);
  const sourceBundle = await loadMap(options.sourceMapId);
  const lifted = liftMapBoundTemplate(sourceTemplate, sourceBundle, { origin: 'auto' });
  if (!lifted.template) {
    throw new CliError('variation_lift_failed', 'source scenario could not be lifted into a portable representation', {
      path: options.file,
      detail: { issues: lifted.issues },
      exitCode: EXIT.validationFindings,
    });
  }
  const portable = lifted.template;
  const { bundle, site } = await findSite(portable, options.targetMapId, options.siteId);
  const product = compileTemplate(portable, bundle, site, materializeOptions(options));
  if (!product.manifest.feasible) {
    throw new CliError('variation_infeasible', 'transferred scenario did not materialize feasibly', {
      path: options.siteId,
      detail: { issues: product.manifest.issues },
      exitCode: EXIT.validationFindings,
    });
  }
  const trace = runSimulation(product.input, { graph: bundle.graph }).trace;
  const variation: ScenarioVariationFile = {
    kind: 'scenario-variation',
    version: 1,
    lineage: {
      sourceTemplate: path.resolve(options.file),
      sourceTemplateDigest: contentHash(sourceTemplate),
      sourceMapId: options.sourceMapId,
      sourceTopologyDigest: sourceBundle.digest,
      targetMapId: options.targetMapId,
      targetSiteId: options.siteId,
      targetTopologyDigest: bundle.digest,
      paramSeed: product.manifest.replayKey.paramSeed,
      drawIndex: product.manifest.replayKey.drawIndex,
      liftIssues: lifted.issues,
    },
    instance: 'instance.json',
    trace: 'trace.json.gz',
  };
  const outputDir = path.resolve(options.out);
  await writeJsonFile(path.join(outputDir, 'portable.template.json'), portable);
  await writeVariation(outputDir, variation, product, trace);
  report(options, variation, sourceTemplate.meta.name, product.manifest.inputHash);
  return EXIT.ok;
}

function materializeOptions(options: { seed?: string | undefined; draw?: number | undefined }) {
  return {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.draw === undefined ? {} : { drawIndex: options.draw }),
  };
}

async function writeVariation(
  output: string,
  variation: ScenarioVariationFile,
  product: Parameters<typeof instanceFile>[0],
  trace: SimTrace,
): Promise<void> {
  const outputDir = path.resolve(output);
  await writeJsonFile(path.join(outputDir, 'instance.json'), instanceFile(product));
  await writeTraceFile(path.join(outputDir, 'trace.json.gz'), trace);
  await writeJsonFile(path.join(outputDir, 'variation.json'), variation);
}

function report(
  options: { out: string; pretty: boolean },
  variation: ScenarioVariationFile,
  name: string,
  inputHash: string,
): void {
  const outputDir = path.resolve(options.out);
  const payload = { ...variation, out: outputDir, feasible: true, inputHash };
  if (!options.pretty) {
    emit(payload, options);
  } else {
    emitLines([
      `${variation.lineage.sourceMapId ? 'transferred' : 'variation'} ${name}`,
      `target ${variation.lineage.targetMapId} · ${variation.lineage.targetSiteId} · feasible true`,
      `inputHash ${inputHash.slice(0, 16)}…`,
      `written ${outputDir}`,
    ]);
  }
}

function assertPortable(template: ScenarioTemplateV2): void {
  const bound = template.roles.filter((role) => role.kind === 'scene_absolute').map((role) => role.id);
  if (bound.length > 0) {
    throw new CliError(
      'variation_source_map_bound',
      'variation fork requires portable roles; map-bound scene_absolute roles need variation transfer',
      { path: 'roles', detail: { sceneAbsoluteRoles: bound }, exitCode: EXIT.validationFindings },
    );
  }
}
