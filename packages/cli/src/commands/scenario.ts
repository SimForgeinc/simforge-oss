import { findOffNetworkDepartures, offNetworkMessage } from '@simforge-oss/compiler';
import { createMapBundle } from '@simforge-oss/compiler/node';
import type { SimTrace } from '@simforge-oss/engine';
import { boolFlag, optionalString, parseArgs } from '../args.js';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  createHttpStudioHost,
  resolveScenarioMap,
  type ScenarioDocumentDto,
  type ScenarioSimulationResultDto,
  type StudioHostServices,
} from '@simforge-oss/studio-host';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';
import { hostSession, type HostSession } from './local.js';

/** Per request the host waits this long on a simulation someone else (a CPU runner) holds. */
const SIMULATION_WAIT_MS = 20_000;

/**
 * Freeze a draft into an immutable execution package, reusing a successful
 * export when available. The host simulates the draft authoritatively (inline,
 * or on a CPU runner) and binds that simulation to the revision; the CLI
 * uploads nothing and only reads the authoritative trace to refuse an
 * off-network scenario early.
 */
export async function freezeScenario(session: HostSession, document: ScenarioDocumentDto, timeoutSeconds = 600) {
  const revisions = await session.host.projects.listRevisions(document.id);
  const current = revisions.find((revision) => revision.sourceDraftVersion === document.draftVersion);
  const exports = current ? await session.host.jobs.listExports(current.id) : [];
  const ready = exports.find((entry) => entry.status === 'succeeded' && entry.executionPackageId);
  if (ready) return { revisionId: current!.id, executionPackageId: ready.executionPackageId!, reused: true };
  const simulation = await authoritativeSimulation(session, document, timeoutSeconds);
  await assertOnDrivableNetwork(session, resolveScenarioMap(document, await session.host.artifacts.listMaps()), simulation);
  const result = await session.host.projects.ensureRevision({
    documentId: document.id,
    expectedDraftVersion: document.draftVersion,
  });
  try {
    const exported = await session.host.jobs.waitForExport(result.revisionId, result.exportId, { attempts: Math.ceil(timeoutSeconds), intervalMs: 1_000 });
    return { revisionId: result.revisionId, executionPackageId: exported.executionPackageId!, reused: false, simKey: simulation.simKey, traceSha256: simulation.traceSha256 };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(/timeout/i.test(message) ? 'export_timeout' : 'export_failed', message, { detail: { revisionId: result.revisionId } });
  }
}

/** The host's authoritative simulation of the draft, waited for until it succeeds, fails or times out. */
export async function authoritativeSimulation(
  session: HostSession,
  document: ScenarioDocumentDto,
  timeoutSeconds = 600,
): Promise<ScenarioSimulationResultDto> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const status = await session.host.projects.resolveSimulation(document, { waitMs: SIMULATION_WAIT_MS });
    if (status.state === 'succeeded') return status.result;
    if (status.state === 'failed') {
      throw new CliError('simulation_failed', status.message ?? `The scenario could not be simulated (${status.failureCode}).`, {
        detail: { documentId: document.id, failureCode: status.failureCode },
      });
    }
    if (Date.now() >= deadline) {
      throw new CliError('simulation_timeout', 'The scenario simulation is still queued; is a CPU runner attached?', {
        detail: { documentId: document.id, requestKey: status.requestKey },
      });
    }
  }
}

async function downloadAuthoritativeTrace(session: HostSession, result: ScenarioSimulationResultDto): Promise<SimTrace> {
  const url = new URL(result.trace.downloadUrl, session.baseUrl);
  // Host credentials go to the host only: a presigned object-store URL carries its own authorization.
  const sameOrigin = url.origin === new URL(session.baseUrl).origin;
  const response = await fetch(url, { ...(sameOrigin ? { headers: session.headers } : {}), redirect: 'follow' });
  if (!response.ok) throw new CliError('simulation_trace_download_failed', `Authoritative trace download failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== result.trace.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== result.trace.gzipSha256) {
    throw new CliError('simulation_trace_invalid', 'Authoritative trace bytes do not match their recorded digest.');
  }
  return JSON.parse(gunzipSync(bytes).toString('utf8')) as SimTrace;
}

/**
 * Refuse a scenario whose actors drive off the drivable network before a
 * revision exists for it.
 *
 * The ASAM export resolves a road-surface elevation for every tick of the
 * replay trace, and refuses a position with no road under it rather than
 * inventing a height for terrain the OpenDRIVE profile does not describe.
 * Asking the same question here, of the authoritative trace, costs one
 * topology fetch and turns a post-hoc `export_failed:
 * xodr_elevation_unresolvable` into an answer the author can act on: which
 * actor, when it leaves, how far off it gets, and what to change.
 */
async function assertOnDrivableNetwork(
  session: HostSession,
  map: { readonly sourceMapId: string; readonly topologyUrl: string },
  simulation: ScenarioSimulationResultDto,
): Promise<void> {
  const response = await fetch(new URL(map.topologyUrl, session.baseUrl), { headers: session.headers, redirect: 'error' });
  if (!response.ok) {
    throw new CliError('map_topology_download_failed', `Map topology download failed (${response.status}).`, {
      detail: { topologyUrl: map.topologyUrl },
    });
  }
  const topology = createMapBundle({
    mapId: map.sourceMapId,
    topology: new Uint8Array(await response.arrayBuffer()),
  }).topology;
  // The authoritative trace is the engine's own xodr-local ledger.
  const departures = findOffNetworkDepartures(await downloadAuthoritativeTrace(session, simulation), topology);
  if (departures.length === 0) return;
  throw new CliError('actor_off_drivable_network', offNetworkMessage(departures), { detail: { departures } });
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
