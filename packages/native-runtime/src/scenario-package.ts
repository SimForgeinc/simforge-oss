/**
 * Scenario packages (`simforge.scenario-package/v1`, docs/engineering/scenario-package.md)
 * through the N-API addon: the Rust `simforge-package` crate writes and
 * verifies every container, so the hosted "Export for CLI" route emits the
 * same bytes the `simforge` CLI would, and refusals carry the same codes.
 *
 * There is no TypeScript fallback: an addon built before scenario packages
 * is refused with an installation error.
 */

import { native } from './index.js';

export type ScenarioPackageForm = 'thin' | 'full';

/** One listed member: `document.json`, `simulation/trace.json.gz`, `timeline/<sha>.json`, ... */
export interface ScenarioPackageMemberInput {
  readonly path: string;
  readonly data: Uint8Array;
}

/** A blob of the full form: bytes, or a file whose sha256 the caller asserts (proven while streamed). */
export type ScenarioPackageBlobInput =
  | { readonly data: Uint8Array; readonly sha256?: string }
  | { readonly sha256: string; readonly file: string };

export interface ScenarioPackageReceiptInput {
  readonly exportedAt: string;
  readonly exporterRelease: string;
  /** Full packages only. */
  readonly textureTier?: string;
}

export interface WriteScenarioPackageInput {
  /** The whole v1 manifest except `members` (the writer computes it from the member bytes). */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly members: readonly ScenarioPackageMemberInput[];
  /** Empty (the default) writes the thin form. */
  readonly blobs?: readonly ScenarioPackageBlobInput[];
  readonly receipt?: ScenarioPackageReceiptInput | null;
}

export interface ScenarioPackageWriteResult {
  readonly packageId: string;
  readonly form: ScenarioPackageForm;
  /** The exact `manifest.json` bytes (canonical JSON); their sha256 is `packageId`. */
  readonly manifestJson: string;
  readonly report: Record<string, unknown>;
}

/** Reader options. `cliVersion` is the reading CLI's semver; `null` for a producer re-checking its own output. */
export interface ScenarioPackageReadOptions {
  readonly cliVersion?: string | null;
}

/** `Verification` of the Rust crate (`inspection` fields flattened, plus `content`). */
export interface ScenarioPackageVerification {
  readonly packageId: string;
  readonly displayId: string;
  readonly form: ScenarioPackageForm;
  readonly containerBytes: number;
  readonly zip64: boolean;
  readonly entries: number;
  readonly manifest: Record<string, unknown>;
  readonly receipt: Record<string, unknown> | null;
  readonly cliCheck: 'passed' | 'not-evaluated';
  readonly content?: Record<string, unknown>;
}

export interface ScenarioPackageReadResult {
  readonly manifestJson: string;
  readonly receiptJson: string | null;
  readonly verification: ScenarioPackageVerification;
  readonly members: readonly { readonly path: string; readonly data: Buffer }[];
  readonly blobs: readonly { readonly sha256: string; readonly data: Buffer }[];
}

export interface ScenarioPackageSkewDimension {
  readonly dimension: string;
  readonly found: string;
  readonly supported: string;
}

/** A refused package or write: `code` is the stable family (`package_*`), `rule` the exact check. */
export class ScenarioPackageError extends Error {
  readonly code: string;
  readonly rule: string;
  readonly path: string | null;
  readonly dimensions: readonly ScenarioPackageSkewDimension[];

  constructor(detail: { code: string; rule: string; message: string; path?: string; dimensions?: ScenarioPackageSkewDimension[] }) {
    super(detail.message);
    this.name = 'ScenarioPackageError';
    this.code = detail.code;
    this.rule = detail.rule;
    this.path = detail.path ?? null;
    this.dimensions = detail.dimensions ?? [];
  }
}

type PackageBinding = Pick<
  ReturnType<typeof native>,
  'scenarioPackageWrite' | 'scenarioPackageVerify' | 'scenarioPackageInspect' | 'scenarioPackageRead'
>;

function binding(): PackageBinding {
  const addon = native();
  if (typeof (addon as Partial<PackageBinding>).scenarioPackageWrite !== 'function') {
    throw new Error(
      '@simforge-oss/native-runtime: the loaded addon predates scenario packages; rebuild it from this checkout ' +
        '(`pnpm --filter @simforge-oss/native-runtime build:node`).',
    );
  }
  return addon;
}

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error) {
      const parts = error.message.split('\u001f');
      if (parts.length === 3 && parts[0] === 'package') {
        throw new ScenarioPackageError(JSON.parse(parts[1]!) as ConstructorParameters<typeof ScenarioPackageError>[0]);
      }
    }
    throw error;
  }
}

function writeArgs(input: WriteScenarioPackageInput) {
  if ('members' in input.manifest) {
    throw new ScenarioPackageError({
      code: 'package_argument_invalid',
      rule: 'draft_members',
      message: 'the manifest draft must not carry members[]; the writer computes it from the member bytes',
    });
  }
  return [
    JSON.stringify(input.manifest),
    input.members.map((m) => ({ path: m.path, data: m.data })),
    (input.blobs ?? []).map((b) => ('file' in b ? { sha256: b.sha256, file: b.file } : { data: b.data, sha256: b.sha256 })),
    input.receipt ? { exportedAt: input.receipt.exportedAt, exporterRelease: input.receipt.exporterRelease, textureTier: input.receipt.textureTier } : null,
  ] as const;
}

function written(result: { packageId: string; form: string; manifestJson: string; reportJson: string }): ScenarioPackageWriteResult {
  return {
    packageId: result.packageId,
    form: result.form as ScenarioPackageForm,
    manifestJson: result.manifestJson,
    report: JSON.parse(result.reportJson) as Record<string, unknown>,
  };
}

/** Write a package into memory. Refuses (with the reader's codes) anything the reader would refuse. */
export function writeScenarioPackage(input: WriteScenarioPackageInput): ScenarioPackageWriteResult & { readonly bytes: Buffer } {
  const [draft, members, blobs, receipt] = writeArgs(input);
  const result = call(() => binding().scenarioPackageWrite(draft, [...members], [...blobs], receipt, null));
  return { ...written(result), bytes: result.bytes! };
}

/** Write a package to `outPath` (through a temporary sibling, renamed when complete); blobs may be files. */
export function writeScenarioPackageFile(outPath: string, input: WriteScenarioPackageInput): ScenarioPackageWriteResult {
  const [draft, members, blobs, receipt] = writeArgs(input);
  return written(call(() => binding().scenarioPackageWrite(draft, [...members], [...blobs], receipt, outPath)));
}

/** Fully verify a container: every member hashed, closures, blobs and cross-checks. */
export function verifyScenarioPackage(bytes: Uint8Array, options: ScenarioPackageReadOptions = {}): ScenarioPackageVerification {
  return JSON.parse(call(() => binding().scenarioPackageVerify(bytes, null, options.cliVersion ?? null))) as ScenarioPackageVerification;
}

export function verifyScenarioPackageFile(path: string, options: ScenarioPackageReadOptions = {}): ScenarioPackageVerification {
  return JSON.parse(call(() => binding().scenarioPackageVerify(null, path, options.cliVersion ?? null))) as ScenarioPackageVerification;
}

/** Structure, manifest and version checks only; no member is hashed. */
export function inspectScenarioPackage(bytes: Uint8Array, options: ScenarioPackageReadOptions = {}): ScenarioPackageVerification {
  return JSON.parse(call(() => binding().scenarioPackageInspect(bytes, options.cliVersion ?? null))) as ScenarioPackageVerification;
}

/** Verify, then return every member and blob. */
export function readScenarioPackage(bytes: Uint8Array, options: ScenarioPackageReadOptions = {}): ScenarioPackageReadResult {
  const out = call(() => binding().scenarioPackageRead(bytes, options.cliVersion ?? null));
  return {
    manifestJson: out.manifestJson,
    receiptJson: out.receiptJson ?? null,
    verification: JSON.parse(out.reportJson) as ScenarioPackageVerification,
    members: out.members,
    blobs: out.blobs,
  };
}
