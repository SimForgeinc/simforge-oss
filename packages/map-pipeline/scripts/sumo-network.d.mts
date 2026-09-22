export const SUMO_DERIVATIVE_REVISION: string;
export const SUMO_VERSION: '1.27.1';
export const SUMO_NETWORK_SCHEMA: 'uniscenarios.sumo-network.v1';
export const SUMO_BUILD_REPORT_SCHEMA: 'simforge.sumo-build-report.v1';
export const SUMO_DERIVED_DIR: 'derived/sumo';
export const SUMO_MEMBER_FILES: Readonly<{ network: 'map.net.xml'; manifest: 'sumo-network-manifest.json'; report: 'sumo-build-report.json' }>;
export const MIN_ROUTE_CANDIDATES: number;
export const SUMO_TYPEMAP_PATH: string;
export const NETCONVERT_OPENDRIVE_OPTIONS: readonly string[];
export const SUMO_GATES: Readonly<Record<string, number>>;
export const SUMO_DERIVATIVE_FINGERPRINT: string;

export function netconvertArguments(xodrPath: string, outputPath: string): string[];

export class SumoBuildError extends Error {
  constructor(code: string, message: string, report: SumoBuildReport | null);
  readonly code: string;
  readonly report: SumoBuildReport | null;
}

export interface SumoToolchain {
  netconvert: string;
  source: string;
  version: string;
  fingerprint: string;
}
export function resolveSumoToolchain(options?: { env?: NodeJS.ProcessEnv; repository?: string }): Promise<SumoToolchain>;
export function sumoBuildKey(input: { xodrSha256: string; mapId: string; sourceMapId?: string }): string;

export interface SumoGateResult { gate: string; reason: string }
export interface SumoBuildReport {
  schema: 'simforge.sumo-build-report.v1';
  mapId: string;
  sourceMapId: string;
  buildKey: string;
  xodrSha256: string;
  status: 'passed' | 'failed';
  failures: SumoGateResult[];
  warnings: SumoGateResult[];
  networkSha256?: string;
  [section: string]: unknown;
}

export interface SumoNetworkManifest {
  schema: 'uniscenarios.sumo-network.v1';
  mapId: string;
  sourceMapId: string;
  sourceOpenDrive: string;
  sourceOpenDriveSha256: string;
  networkFile: string;
  networkBytes: number;
  sha256: string;
  buildKey: string;
  generator: { name: string; revision: string; sumoVersion: string; routeSeed: number; netconvertOptions: readonly string[]; typemapSha256: string; unsetTrafficLights: string[] };
  sumoLocation: { netOffset: string; convBoundary: string; origBoundary: string; projParameter: string };
  worldFromNetwork: { translationX: number; translationY: number; rotationDegrees: number; scale: number; invertY: boolean };
  trafficLights: number;
  report: string;
  routeCandidates: string[][];
}

export interface SumoDerivativeBuild {
  buildKey: string;
  manifest: SumoNetworkManifest;
  report: SumoBuildReport;
  files: Record<string, { sha256: string; bytes: number }>;
}

export function buildSumoDerivative(options: {
  xodrPath: string;
  topologyPath: string;
  mapId: string;
  sourceMapId?: string;
  outputDir: string;
  toolchain?: SumoToolchain;
  runtimeDir?: string;
  simulate?: boolean;
  writeFailedReport?: boolean;
}): Promise<SumoDerivativeBuild>;

export function inspectSumoDerivative(options: { outputDir: string; xodrPath: string; mapId: string; sourceMapId?: string }): Promise<{
  state: 'missing' | 'corrupt' | 'stale' | 'current';
  expectedKey: string;
  manifest?: SumoNetworkManifest;
}>;

export interface ParsedSumoNetwork {
  location: SumoNetworkManifest['sumoLocation'];
  netOffset: [number, number];
  edges: Map<string, { id: string; function: string; from?: string; to?: string; lanes: Array<{ id: string; index: number; speed: number; length: number; passenger: boolean; shape: number[][] }> }>;
  connections: Array<{ from: string; to: string; fromLane: number; toLane: number; via?: string; tl?: string; linkIndex?: number }>;
  trafficLights: Array<{ id: string; type?: string; phases: Array<{ duration: number; state: string }>; linkSignals: Map<number, string[]> }>;
  junctions: Array<{ id: string; type?: string }>;
}
export function parseSumoNetwork(xml: string): ParsedSumoNetwork;
export function normalizeNetconvertXml(bytes: Uint8Array): Buffer;
export function generateRouteCandidates(network: ParsedSumoNetwork, options?: { seed?: number; limit?: number; minDistanceM?: number }): {
  routes: string[][];
  drivableEdges: number;
  sourceEdges: number;
  sinkEdges: number;
  reachableFringePairs: number | null;
};
export function drivingLanesFromTopology(topology: unknown): Array<{ rsl: string; junction: boolean; points: number[][] }>;
export function signalHeadsFromXodr(xodrXml: string): {
  heads: Set<string>;
  junctionHeads: Map<string, Set<string>>;
  roadHeads: Map<string, Array<{ id: string; validity: [number, number] | null }>>;
};
export function bindSignalHeads(networkXml: string, xodrXml: string): { xml: string; inferredLinks: number };
export function registerLaneShapes(networkXml: string, topology: unknown, netOffset: [number, number]): {
  xml: string;
  stats: { lanes: number; registered: number; byIdentity: number; slivers: number; unmatched: number; rejected: number; maxShiftM: number; identitySample: string[]; rejectedSample: string[]; unmatchedSample: string[] };
};
export function phantomTrafficLights(network: ParsedSumoNetwork): string[];
export function validateSumoNetwork(input: {
  network: ParsedSumoNetwork;
  routes: ReturnType<typeof generateRouteCandidates>;
  xodrXml: string;
  topology: unknown;
  registration?: ReturnType<typeof registerLaneShapes>['stats'];
}): { structure: unknown; alignment: unknown; signals: unknown; demand: unknown; failures: SumoGateResult[]; warnings: SumoGateResult[] };
export function simulateSumoNetwork(input: {
  runtimeDir: string;
  networkBytes: Uint8Array;
  network: ParsedSumoNetwork;
  routes: string[][];
  topology: unknown;
}): Promise<{ simulation: Record<string, unknown>; failures: SumoGateResult[] }>;
