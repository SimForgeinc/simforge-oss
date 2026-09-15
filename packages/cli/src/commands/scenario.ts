import { admitSimulationPreview } from '@simforge-oss/playback';
import { browserRevisionTraffic } from '@simforge-oss/playback/traffic';
import { boolFlag, optionalString, parseArgs } from '../args.js';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  ambientProvenanceForRevisionTraffic,
  createHttpStudioHost,
  type ScenarioDocumentDto,
  type StudioHostServices,
} from '@simforge-oss/studio-host';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';
import { hostSession, type HostSession } from './local.js';



/** Freeze a draft into an immutable execution package, reusing a successful export when available. */
export async function freezeScenario(session: HostSession, document: ScenarioDocumentDto, timeoutSeconds = 600) {
  const revisions = await session.host.projects.listRevisions(document.id);
  const current = revisions.find((revision) => revision.sourceDraftVersion === document.draftVersion);
  const exports = current ? await session.host.jobs.listExports(current.id) : [];
  const ready = exports.find((entry) => entry.status === 'succeeded' && entry.executionPackageId);
  if (ready) return { revisionId: current!.id, executionPackageId: ready.executionPackageId!, reused: true };
  const result = await session.host.projects.ensureRevision({
    documentId: document.id,
    expectedDraftVersion: document.draftVersion,
    evidence: await materializeRevisionEvidence(session, document),
  });
  try {
    const exported = await session.host.jobs.waitForExport(result.revisionId, result.exportId, { attempts: Math.ceil(timeoutSeconds), intervalMs: 1_000 });
    return { revisionId: result.revisionId, executionPackageId: exported.executionPackageId!, reused: false };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(/timeout/i.test(message) ? 'export_timeout' : 'export_failed', message, { detail: { revisionId: result.revisionId } });
  }
}

/** Deterministic browser-engine evidence for a draft with a saved simulation; the CLI half of the wizard's freeze. */
export async function materializeRevisionEvidence(session: HostSession, document: ScenarioDocumentDto) {
  const { host } = session;
  const preview = await host.projects.getSimulationPreview(document.id);
  if (!preview) {
    throw new CliError('simulation_preview_missing', 'This draft has no saved simulation. Open it in Studio once so the browser engine simulates and saves it.', { detail: { documentId: document.id } });
  }
  if (preview.draftVersion !== document.draftVersion) {
    throw new CliError('simulation_preview_stale', 'The saved simulation belongs to an older draft version. Open the scenario in Studio to re-simulate.', {
      detail: { documentId: document.id, draftVersion: document.draftVersion, previewDraftVersion: preview.draftVersion },
    });
  }
  const response = await fetch(new URL(preview.downloadUrl, session.baseUrl), { headers: session.headers, redirect: 'error' });
  if (!response.ok) throw new CliError('simulation_preview_download_failed', `Saved simulation download failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== preview.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== preview.sha256) {
    throw new CliError('simulation_preview_invalid', 'Saved simulation bytes do not match their recorded digest.');
  }
  const bundle = admitSimulationPreview(JSON.parse(gunzipSync(bytes).toString('utf8')), { draftVersion: document.draftVersion });

  if (!document.mapVersionId) throw new CliError('map_missing', 'The scenario is not bound to a map version.', { detail: { documentId: document.id } });
  const map = (await host.artifacts.listMaps()).find((entry) => entry.mapVersionId === document.mapVersionId);
  if (!map) throw new CliError('map_missing', 'The scenario map is not installed on this host.', { detail: { mapVersionId: document.mapVersionId } });

  const traffic = browserRevisionTraffic(document.content, map, bundle);
  if (!traffic) {
    throw new CliError('sumo_evidence_unsupported', 'This draft runs ambient traffic through SUMO; freeze it from Studio, which owns the SUMO bridge.', { detail: { documentId: document.id } });
  }
  const { artifact, profile } = traffic;
  const materializedTraffic = await host.projects.uploadMaterializedTraffic(
    document,
    {
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      mapAssetId: artifact.artifact.map.assetId,
      mapVersionId: artifact.artifact.map.versionId,
    },
    artifact.artifact.sourceInputDigest,
  );
  return { ambient: ambientProvenanceForRevisionTraffic(artifact, profile, map), materializedTraffic };
}

export const SCENARIO_COMMANDS = ['list', 'show'] as const;

export async function scenarioCommand(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  if (!SCENARIO_COMMANDS.includes(sub as typeof SCENARIO_COMMANDS[number])) throw new CliError('unknown_command', `Unknown scenario command: ${sub ?? '(none)'}`, { detail: { known: SCENARIO_COMMANDS } });
  const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: ['data-root', ...(sub === 'list' ? ['dataset'] : [])] });
  const id = args.positionals[0];
  if (args.positionals.length !== (sub === 'show' ? 1 : 0)) throw new CliError('bad_value', sub === 'show' ? 'scenario show requires one document id' : 'scenario list takes no positional arguments');
  const options = { dataRoot: optionalString(args, 'data-root'), dataset: optionalString(args, 'dataset') };
  const session = await hostSession(options.dataRoot);
  const pretty = boolFlag(args, 'pretty');
  switch (sub) {
    case 'list': {
      const datasets = options.dataset ? [options.dataset] : (await session.host.projects.listDatasets()).map((dataset) => dataset.id);
      const documents = [];
      for (const datasetId of datasets) {
        let cursor: string | null = null;
        do {
          const page = await session.host.projects.listDocumentSummaries({ datasetId, cursor });
          documents.push(...page.documents);
          cursor = page.nextCursor;
        } while (cursor);
      }
      emit(documents, { pretty });
      return EXIT.ok;
    }
    case 'show': {
      if (!id) throw new CliError('missing_argument', '`simforge scenario show` requires a document id.');
      emit(await session.host.projects.getDocument(id), { pretty });
      return EXIT.ok;
    }
    default:
      throw new CliError('unknown_command', `Unknown scenario command: ${sub ?? '(none)'}`, { detail: { known: SCENARIO_COMMANDS } });
  }
}
