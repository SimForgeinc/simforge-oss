import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HF_IDENTITY_ACCOUNT, HF_TOKEN_ACCOUNT, MODEL_VAULT_SERVICE, openModelVault } from "./vault";
import {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  type ModelFamilyId,
  type ModelInstallState,
  type ModelInstallStep,
  type ModelQuant,
} from "./catalog";
import { DownloadError, downloadLockedFile, tokenIdentity } from "./download";
import { checkpointDigestFromLock, verifyFile, type FileVerdict } from "./integrity";
import { installFiles, lockEntry, type ModelLockEntry } from "./lock";
import { hfCacheRoot, installLayout, modelsRoot, INSTALL_SCHEMA, type InstallLayout } from "./paths";

/**
 * The model-store install engine.
 *
 * Runs in the studio host process (never the renderer, never the Electron
 * main process) so a multi-gigabyte transfer cannot block the UI thread and
 * so the same code serves the desktop routes and the `simforge models` CLI.
 *
 * Durability is on disk, not in memory: `<install root>/install.json` records
 * which steps completed and every incomplete file leaves a `<file>.part`.
 * That is what makes an install resumable across an app restart — the
 * in-memory job below is only the *live* progress view, and losing it costs
 * nothing but the current transfer.
 *
 * Download eligibility and execution eligibility stay separate throughout: a
 * machine with the disk may install Alpamayo 2 Super and still be told, in
 * the same UI, that it can only be executed in the cloud.
 */

/** Concurrency 2: the shards are ~5 GB and the transfer is disk-bound. */
const FILE_CONCURRENCY = 2;

export type InstallRecord = {
  schema: typeof INSTALL_SCHEMA;
  family: ModelFamilyId;
  revision: string;
  quant: ModelQuant | null;
  checkpointDigest: string;
  steps: Partial<Record<ModelInstallStep, { completedAt: string; detail?: unknown }>>;
  licenses: {
    weights: { id: string; blobSha: string; acceptedAt: string | null };
    sidecars: { repo: string; license: string | null; gated: boolean | "auto"; acceptedAt: string | null }[];
  };
  /** Hugging Face account NAME only. The token never enters this file. */
  tokenIdentity: string | null;
  weights: { files: { path: string; sha256: string | null; blobId: string | null; sizeBytes: number | null }[] };
  installedAt: string | null;
  digestVerifiedAt: string | null;
  bytesOnDisk: number | null;
};

type Job = {
  family: ModelFamilyId;
  quant: ModelQuant;
  step: ModelInstallStep;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  currentFile?: string;
  startedAt: number;
  bytesAtStart: number;
  controller: AbortController;
  paused: boolean;
  error?: { code: string; message: string; retryable: boolean; resumable: boolean };
  verifying?: { filesDone: number; filesTotal: number; currentFile?: string };
};

/** Live jobs keyed `family` — one install per family at a time. */
const jobs = new Map<ModelFamilyId, Job>();

/** Bumped on every observable change, so a poller can skip re-rendering. */
let generation = 0;

export function stateGeneration(): number {
  return generation;
}

export class InstallConflict extends Error {
  readonly code = "install_in_progress";
}

export class TokenRequired extends Error {
  readonly code = "hf_token_required";
  constructor(readonly detail: { repo: string; revision: string; acceptUrl: string }) {
    super(`a Hugging Face token is required for ${detail.repo}`);
  }
}

export class LicenseAcceptanceRequired extends Error {
  readonly code = "license_acceptance_required";
  constructor(readonly detail: { license: string; blobSha: string }) {
    super(`the ${detail.license} licence must be accepted before installing`);
  }
}

// -- install record ---------------------------------------------------------

async function readRecord(layout: InstallLayout): Promise<InstallRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(layout.installJson, "utf8")) as InstallRecord;
    return parsed.schema === INSTALL_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRecord(layout: InstallLayout, record: InstallRecord): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  await writeFile(layout.installJson, `${JSON.stringify(record, null, 2)}\n`);
  generation += 1;
}

function newRecord(
  family: ModelFamilyId,
  entry: ModelLockEntry,
  quant: ModelQuant,
  acceptedAt: string,
): InstallRecord {
  return {
    schema: INSTALL_SCHEMA,
    family,
    revision: entry.weights.revision,
    quant,
    checkpointDigest: entry.weights.checkpointDigest,
    steps: {},
    licenses: {
      weights: {
        id: entry.weights.license,
        blobSha: entry.weights.licenseBlobSha,
        acceptedAt,
      },
      sidecars: entry.sidecars.map((sidecar) => ({
        repo: sidecar.repo,
        license: sidecar.license,
        gated: sidecar.gated,
        acceptedAt: sidecar.gated === false ? acceptedAt : null,
      })),
    },
    tokenIdentity: null,
    weights: {
      files: entry.weights.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        blobId: file.blobId,
        sizeBytes: file.sizeBytes,
      })),
    },
    installedAt: null,
    digestVerifiedAt: null,
    bytesOnDisk: null,
  };
}

// -- token vault ------------------------------------------------------------

/** Where the Hugging Face token lives on this machine, and whose it is. */
export type VaultStatus = {
  readonly persistence: "os-vault" | "session";
  readonly hfTokenPresent: boolean;
  /** Hugging Face account NAME only; the token value never leaves the vault. */
  readonly hfTokenIdentity: string | null;
};

export async function vaultStatus(): Promise<VaultStatus> {
  const vault = await openModelVault(MODEL_VAULT_SERVICE);
  const token = await vault.get(HF_TOKEN_ACCOUNT);
  const identity = await vault.get(HF_IDENTITY_ACCOUNT);
  return {
    persistence: vault.persistence,
    hfTokenPresent: Boolean(token),
    hfTokenIdentity: identity,
  };
}

/**
 * Store a Hugging Face token in the OS vault and record only the account
 * name. When no OS vault exists the value is memory-only for this process —
 * there is deliberately no plaintext fallback, matching the cloud sign-in
 * vault this reuses.
 */
export async function storeHfToken(token: string): Promise<{ name: string | null; persistence: string }> {
  const vault = await openModelVault(MODEL_VAULT_SERVICE);
  const identity = await tokenIdentity(token);
  await vault.set(HF_TOKEN_ACCOUNT, token);
  if (identity?.name) await vault.set(HF_IDENTITY_ACCOUNT, identity.name);
  generation += 1;
  return { name: identity?.name ?? null, persistence: vault.persistence };
}

export async function clearHfToken(): Promise<boolean> {
  const vault = await openModelVault(MODEL_VAULT_SERVICE);
  const removed = await vault.delete(HF_TOKEN_ACCOUNT);
  await vault.delete(HF_IDENTITY_ACCOUNT);
  generation += 1;
  return removed;
}

async function readHfToken(): Promise<string | null> {
  const vault = await openModelVault(MODEL_VAULT_SERVICE);
  return vault.get(HF_TOKEN_ACCOUNT);
}

// -- state reporting --------------------------------------------------------

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

/** Live state for one family, from the in-memory job or the on-disk record. */
export async function installState(family: ModelFamilyId): Promise<ModelInstallState> {
  const job = jobs.get(family);
  if (job) {
    if (job.error) {
      return {
        state: "error",
        code: job.error.code,
        message: job.error.message,
        retryable: job.error.retryable,
        resumable: job.error.resumable,
        step: job.step,
      };
    }
    if (job.verifying) {
      return {
        state: "verifying",
        filesDone: job.verifying.filesDone,
        filesTotal: job.verifying.filesTotal,
        ...(job.verifying.currentFile ? { currentFile: job.verifying.currentFile } : {}),
      };
    }
    if (job.paused) {
      return {
        state: "paused",
        bytesDone: job.bytesDone,
        bytesTotal: job.bytesTotal,
        filesDone: job.filesDone,
        filesTotal: job.filesTotal,
        resumable: true,
        step: job.step,
      };
    }
    const elapsed = (Date.now() - job.startedAt) / 1000;
    const moved = job.bytesDone - job.bytesAtStart;
    // Rate is over this session's transfer only; a resumed install must not
    // report an average that includes bytes it never moved.
    const ratePerSec = elapsed > 1 && moved > 0 ? Math.round(moved / elapsed) : undefined;
    const remaining = Math.max(0, job.bytesTotal - job.bytesDone);
    return {
      state: "downloading",
      bytesDone: job.bytesDone,
      bytesTotal: job.bytesTotal,
      filesDone: job.filesDone,
      filesTotal: job.filesTotal,
      ...(ratePerSec ? { ratePerSec, etaSeconds: Math.round(remaining / ratePerSec) } : {}),
      ...(job.currentFile ? { currentFile: job.currentFile } : {}),
      resumable: true,
      step: job.step,
    };
  }

  const entry = await lockEntry(family);
  const layout = installLayout(family, entry.weights.revision);
  const record = await readRecord(layout);
  if (!record) return { state: "not_installed" };

  if (record.installedAt && record.steps.register) {
    return {
      state: "installed",
      installedAt: record.installedAt,
      bytesOnDisk: record.bytesOnDisk ?? (await directoryBytes(layout.root)),
      revision: record.revision,
      checkpointDigest: record.checkpointDigest,
      digestVerifiedAt: record.digestVerifiedAt,
      quant: record.quant ?? "bf16",
    };
  }

  // A record with incomplete steps and partial bytes on disk is a paused
  // install, not a failure: the user closed the app mid-download.
  const files = installFiles(entry);
  let bytesDone = 0;
  let filesDone = 0;
  for (const item of files) {
    const target = join(layout.root, item.destination);
    try {
      bytesDone += (await stat(target)).size;
      filesDone += 1;
    } catch {
      try {
        bytesDone += (await stat(`${target}.part`)).size;
      } catch {
        /* not started */
      }
    }
  }
  const bytesTotal = files.reduce((sum, item) => sum + (item.file.sizeBytes ?? 0), 0);
  return {
    state: "paused",
    bytesDone,
    bytesTotal,
    filesDone,
    filesTotal: files.length,
    resumable: true,
    step: (Object.keys(record.steps).at(-1) as ModelInstallStep | undefined) ?? "download-weights",
  };
}

export async function allInstallStates(): Promise<
  { family: ModelFamilyId; quant: ModelQuant | null; state: ModelInstallState }[]
> {
  const out = [];
  for (const family of MODEL_FAMILIES) {
    const state = await installState(family);
    const quant = state.state === "installed" ? state.quant : null;
    out.push({ family, quant, state });
  }
  return out;
}

// -- install ----------------------------------------------------------------

export type StartInstallInput = {
  family: ModelFamilyId;
  quant: ModelQuant;
  hfToken?: string;
  acceptLicense: boolean;
  acceptSidecarLicense?: boolean;
};

/**
 * Begin (or resume) an install. Returns as soon as the job is registered; the
 * transfer continues in the background and is observed through
 * {@link installState}.
 */
export async function startInstall(input: StartInstallInput): Promise<ModelInstallState> {
  const { family, quant } = input;
  const catalog = MODEL_CATALOG[family];
  const offer = catalog.quants.find((candidate) => candidate.quant === quant);
  if (!offer) throw new Error(`${family} does not offer quant ${quant}`);
  if (offer.status === "unsupported") {
    throw new Error(`${family} does not support ${quant}: ${offer.note}`);
  }
  const existing = jobs.get(family);
  if (existing && !existing.paused && !existing.error) throw new InstallConflict(`${family} install already running`);

  const entry = await lockEntry(family);
  if (!input.acceptLicense) {
    throw new LicenseAcceptanceRequired({
      license: entry.weights.license,
      blobSha: entry.weights.licenseBlobSha,
    });
  }

  if (input.hfToken) await storeHfToken(input.hfToken);
  const token = await readHfToken();
  const gatedSidecar = entry.sidecars.find((sidecar) => sidecar.gated !== false);
  if (gatedSidecar && !token) {
    throw new TokenRequired({
      repo: gatedSidecar.repo,
      revision: gatedSidecar.revision,
      acceptUrl: `https://huggingface.co/${gatedSidecar.repo}`,
    });
  }
  if (gatedSidecar && !input.acceptSidecarLicense) {
    const already = await readRecord(installLayout(family, entry.weights.revision));
    const accepted = already?.licenses.sidecars.find(
      (sidecar) => sidecar.repo === gatedSidecar.repo,
    )?.acceptedAt;
    if (!accepted) {
      throw new LicenseAcceptanceRequired({
        license: gatedSidecar.license ?? "NVIDIA Open Model License",
        blobSha: gatedSidecar.revision,
      });
    }
  }

  const layout = installLayout(family, entry.weights.revision);
  const now = new Date().toISOString();
  let record = await readRecord(layout);
  if (!record) {
    record = newRecord(family, entry, quant, now);
  } else {
    record.quant = quant;
    record.licenses.weights.acceptedAt ??= now;
  }
  if (gatedSidecar && input.acceptSidecarLicense) {
    for (const sidecar of record.licenses.sidecars) {
      if (sidecar.repo === gatedSidecar.repo) sidecar.acceptedAt ??= now;
    }
  }
  if (token) {
    const identity = await openModelVault(MODEL_VAULT_SERVICE).then((vault) =>
      vault.get(HF_IDENTITY_ACCOUNT),
    );
    record.tokenIdentity = identity;
  }
  record.steps.license = { completedAt: now };
  if (gatedSidecar) record.steps["sidecar-license"] = { completedAt: now };
  await writeRecord(layout, record);

  const files = installFiles(entry);
  const job: Job = {
    family,
    quant,
    step: "download-weights",
    bytesDone: 0,
    bytesTotal: files.reduce((sum, item) => sum + (item.file.sizeBytes ?? 0), 0),
    filesDone: 0,
    filesTotal: files.length,
    startedAt: Date.now(),
    bytesAtStart: 0,
    controller: new AbortController(),
    paused: false,
  };
  jobs.set(family, job);
  generation += 1;

  void runInstall(job, entry, layout, token).catch((error: unknown) => {
    const download = error instanceof DownloadError ? error : null;
    job.error = {
      code: download?.code ?? "install_failed",
      message: (error as Error).message,
      retryable: download?.retryable ?? true,
      // Everything except a licence/permission failure can be resumed: the
      // `.part` files and install.json survive.
      resumable: download?.code !== "unauthorized" && download?.code !== "gated",
    };
    generation += 1;
  });

  return installState(family);
}

async function runInstall(
  job: Job,
  entry: ModelLockEntry,
  layout: InstallLayout,
  token: string | null,
): Promise<void> {
  const files = installFiles(entry);
  // Count what is already on disk so a resumed install reports true progress
  // rather than restarting its byte counter at zero, and queue only the files
  // that are still missing.
  const queue: typeof files = [];
  for (const item of files) {
    try {
      job.bytesDone += (await stat(join(layout.root, item.destination))).size;
      job.filesDone += 1;
    } catch {
      // Absent or partial: `downloadLockedFile` resumes from the `.part`.
      queue.push(item);
    }
  }
  job.bytesAtStart = job.bytesDone;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      if (job.controller.signal.aborted) return;
      const item = queue[cursor++];
      if (!item) return;
      const destination = join(layout.root, item.destination);
      job.step = item.role === "weights" ? "download-weights" : "download-sidecars";
      job.currentFile = item.file.path;
      let carried = 0;
      const result = await downloadLockedFile({
        repo: item.repo,
        revision: item.revision,
        file: item.file,
        destination,
        // A token goes only to a repo the lock marks gated. The ungated
        // Alpamayo weights and Qwen sidecars are fetched anonymously, so a
        // user's credential is not attached to requests that never need it.
        token: item.gated === false ? null : token,
        signal: job.controller.signal,
        onProgress: (progress) => {
          job.bytesDone += progress.bytesDone - progress.resumedFrom - carried;
          carried = progress.bytesDone - progress.resumedFrom;
          generation += 1;
        },
      });
      if (!result.skipped) {
        job.bytesDone += Math.max(0, result.bytes - result.resumedFrom - carried);
      }
      job.filesDone += 1;
      generation += 1;
    }
  };
  await Promise.all(Array.from({ length: FILE_CONCURRENCY }, worker));
  if (job.controller.signal.aborted) return;

  const record = (await readRecord(layout)) ?? newRecord(job.family, entry, job.quant, new Date().toISOString());
  record.steps["download-weights"] = { completedAt: new Date().toISOString() };
  record.steps["download-sidecars"] = { completedAt: new Date().toISOString() };
  await writeRecord(layout, record);

  // Verification is its own step and its own reported state: "downloaded" and
  // "verified" are different claims and the UI shows them separately.
  job.step = "verify";
  job.verifying = { filesDone: 0, filesTotal: files.length };
  const failures: FileVerdict[] = [];
  for (const item of files) {
    job.verifying.currentFile = item.file.path;
    const verdict = await verifyFile(join(layout.root, item.destination), item.file);
    if (!verdict.digestOk) failures.push(verdict);
    job.verifying.filesDone += 1;
    generation += 1;
  }
  job.verifying = undefined;
  if (failures.length) {
    throw new DownloadError(
      `verification failed for ${failures.length} file(s): ${failures
        .map((verdict) => `${verdict.path} (${verdict.reason ?? "digest mismatch"})`)
        .join(", ")}`,
      "digest_mismatch",
      true,
      { failures },
    );
  }

  await writeLicenseCopies(layout, entry);
  const now = new Date().toISOString();
  record.steps.verify = { completedAt: now };
  record.digestVerifiedAt = now;
  record.checkpointDigest = checkpointDigestFromLock(entry.weights.files);
  record.bytesOnDisk = await directoryBytes(layout.root);
  // `register` marks the install usable. The isolated Python runtime is a
  // separate, explicitly-invoked step (`simforge models prepare`): a user who
  // only wants the weights for cloud execution should not be made to build a
  // torch environment, and a venv build failure must not discard 22 GB of
  // verified weights.
  record.steps.register = { completedAt: now, detail: { runtime: "not-prepared" } };
  record.installedAt = now;
  await writeRecord(layout, record);
  jobs.delete(job.family);
  generation += 1;
}

/**
 * OpenMDW-1.1 requires the licence and provenance to travel with the weights.
 * We do not redistribute them, but keeping the texts next to the install is
 * what lets the app show the exact terms for the exact revision on disk.
 */
async function writeLicenseCopies(layout: InstallLayout, entry: ModelLockEntry): Promise<void> {
  await mkdir(layout.licenses, { recursive: true });
  const source = join(layout.weights, "LICENSE");
  const notice = [
    `Model: ${entry.weights.repo}`,
    `Revision: ${entry.weights.revision}`,
    `Weights licence: ${entry.weights.license} (LICENSE blob ${entry.weights.licenseBlobSha})`,
    `Checkpoint digest: ${entry.weights.checkpointDigest}`,
    `Upstream inference code: ${entry.code.git}@${entry.code.commit} (${entry.code.license})`,
    ...entry.sidecars.map(
      (sidecar) =>
        `Sidecar: ${sidecar.repo}@${sidecar.revision} (${sidecar.license ?? "licence unstated"}` +
        `${sidecar.gated === false ? "" : ", gated"}) — configuration and tokenizer only, no weights`,
    ),
    "",
    "The model card's prose and the LICENSE blob do not agree for every family;",
    "both texts are presented verbatim in the application and neither is",
    "paraphrased here. Commercial use requires a recorded licence review.",
    "",
  ].join("\n");
  await writeFile(join(layout.licenses, "NOTICE.txt"), notice);
  try {
    await writeFile(join(layout.licenses, "LICENSE"), await readFile(source));
  } catch {
    /* the weights LICENSE is downloaded with the rest; absence is reported by verify */
  }
}

// -- control ----------------------------------------------------------------

export async function pauseInstall(family: ModelFamilyId): Promise<ModelInstallState> {
  const job = jobs.get(family);
  if (job) {
    job.paused = true;
    job.controller.abort();
    generation += 1;
  }
  return installState(family);
}

export async function resumeInstall(family: ModelFamilyId, quant: ModelQuant): Promise<ModelInstallState> {
  const job = jobs.get(family);
  if (job) jobs.delete(family);
  return startInstall({ family, quant, acceptLicense: true, acceptSidecarLicense: true });
}

export async function cancelInstall(
  family: ModelFamilyId,
  discardPartials = false,
): Promise<ModelInstallState> {
  const job = jobs.get(family);
  if (job) {
    job.controller.abort();
    jobs.delete(family);
  }
  if (discardPartials) {
    const entry = await lockEntry(family);
    await rm(installLayout(family, entry.weights.revision).root, { recursive: true, force: true });
  }
  generation += 1;
  return installState(family);
}

// -- verify / uninstall / cache --------------------------------------------

export async function verifyInstall(
  family: ModelFamilyId,
  options: { deep?: boolean } = {},
): Promise<{ ok: boolean; verified: FileVerdict[]; failed: FileVerdict[]; checkpointDigest: string }> {
  const entry = await lockEntry(family);
  const layout = installLayout(family, entry.weights.revision);
  const files = installFiles(entry);
  const verified: FileVerdict[] = [];
  const failed: FileVerdict[] = [];
  for (const item of files) {
    // `deep` streams and re-hashes every shard. Without it, a shard whose
    // size matches is accepted on its size alone — cheap, and honest about
    // being cheaper: the returned verdict records which check ran.
    const target = join(layout.root, item.destination);
    const verdict = options.deep
      ? await verifyFile(target, item.file)
      : await shallowVerify(target, item.file);
    (verdict.digestOk || (!options.deep && verdict.sizeOk) ? verified : failed).push(verdict);
  }
  if (!failed.length) {
    const record = await readRecord(layout);
    if (record) {
      record.digestVerifiedAt = new Date().toISOString();
      await writeRecord(layout, record);
    }
  }
  return {
    ok: failed.length === 0,
    verified,
    failed,
    checkpointDigest: entry.weights.checkpointDigest,
  };
}

async function shallowVerify(path: string, file: Parameters<typeof verifyFile>[1]): Promise<FileVerdict> {
  try {
    const size = (await stat(path)).size;
    const sizeOk = file.sizeBytes === null || size === file.sizeBytes;
    return {
      path: file.path,
      present: true,
      sizeBytes: size,
      sizeOk,
      digestOk: false,
      digestSource: file.digestSource,
      expected: file.digestSource === "hf-lfs" ? (file.sha256 ?? "") : (file.blobId ?? ""),
      actual: null,
      reason: sizeOk ? "size-only check; pass deep=true to re-hash" : `size ${size} != ${file.sizeBytes}`,
    };
  } catch {
    return {
      path: file.path,
      present: false,
      sizeBytes: null,
      sizeOk: false,
      digestOk: false,
      digestSource: file.digestSource,
      expected: "",
      actual: null,
      reason: "missing",
    };
  }
}

export async function uninstall(
  family: ModelFamilyId,
  options: { purgeSharedCache?: boolean } = {},
): Promise<{ removed: string[]; freedBytes: number }> {
  const entry = await lockEntry(family);
  const layout = installLayout(family, entry.weights.revision);
  const removed: string[] = [];
  let freedBytes = 0;

  await cancelInstall(family);
  const bytes = await directoryBytes(layout.root);
  if (bytes > 0) {
    await rm(layout.root, { recursive: true, force: true });
    removed.push(layout.root);
    freedBytes += bytes;
  }
  if (options.purgeSharedCache) {
    // The HF blob cache is shared with upstream tooling and other families,
    // so it is only touched on an explicit request and only for this repo.
    const cacheDir = join(hfCacheRoot(), "hub", `models--${entry.weights.repo.replace("/", "--")}`);
    const cacheBytes = await directoryBytes(cacheDir);
    if (cacheBytes > 0) {
      await rm(cacheDir, { recursive: true, force: true });
      removed.push(cacheDir);
      freedBytes += cacheBytes;
    }
  }
  generation += 1;
  return { removed, freedBytes };
}

/**
 * Shared-cache reclamation.
 *
 * The HF cache exists so upstream tooling and our store share blobs, which
 * means an entry may be referenced by an install even though the store did
 * not create it. Every candidate is therefore reported with what references
 * it, and `dryRun` is the default posture in the UI.
 */
export async function reclaimCache(
  options: { dryRun?: boolean } = {},
): Promise<{ reclaimableBytes: number; entries: { path: string; bytes: number; referencedBy: string[] }[]; freedBytes: number }> {
  const hub = join(hfCacheRoot(), "hub");
  const referencedRepos = new Map<string, string[]>();
  for (const family of MODEL_FAMILIES) {
    const entry = await lockEntry(family);
    const layout = installLayout(family, entry.weights.revision);
    if (!(await readRecord(layout))) continue;
    for (const repo of [entry.weights.repo, ...entry.sidecars.map((sidecar) => sidecar.repo)]) {
      const key = `models--${repo.replace("/", "--")}`;
      referencedRepos.set(key, [...(referencedRepos.get(key) ?? []), family]);
    }
  }

  let dirents;
  try {
    dirents = await readdir(hub, { withFileTypes: true });
  } catch {
    return { reclaimableBytes: 0, entries: [], freedBytes: 0 };
  }

  const entries = [];
  let reclaimableBytes = 0;
  let freedBytes = 0;
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const path = join(hub, dirent.name);
    const bytes = await directoryBytes(path);
    const referencedBy = referencedRepos.get(dirent.name) ?? [];
    entries.push({ path, bytes, referencedBy });
    if (referencedBy.length === 0) {
      reclaimableBytes += bytes;
      if (options.dryRun === false) {
        await rm(path, { recursive: true, force: true });
        freedBytes += bytes;
      }
    }
  }
  if (freedBytes > 0) generation += 1;
  return { reclaimableBytes, entries, freedBytes };
}

export async function installRecord(family: ModelFamilyId): Promise<InstallRecord | null> {
  const entry = await lockEntry(family);
  return readRecord(installLayout(family, entry.weights.revision));
}

export { modelsRoot };
