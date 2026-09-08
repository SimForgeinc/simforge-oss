import {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  cancelInstall,
  installLayout,
  installRecord,
  installState,
  lockEntry,
  isModelFamilyId,
  loadModelLock,
  preflight,
  prepareRuntime,
  readRuntimeRecord,
  reclaimCache,
  startInstall,
  storeHfToken,
  uninstall,
  vaultStatus,
  verifyInstall,
  type ModelFamilyId,
  type ModelQuant,
} from '@simforge-oss/model-store';
import { CliError } from '../errors.js';
import { emit } from '../output.js';

/**
 * `simforge models …` — the terminal surface of the model store.
 *
 * The CLI and the desktop host share one implementation
 * (`@simforge-oss/model-store`), so an install started in the app can be
 * verified, resumed or removed from a shell and vice versa: the durable state
 * is the install record and the `.part` files on disk, not a process.
 *
 * Every command follows the repository CLI contract: stdout is one JSON
 * document, exit 0 on success, exit 2 when the command ran and found
 * something wrong with the request or the machine.
 */
export type ModelsOptions = {
  pretty?: boolean;
};

/**
 * A one-second tick between install-state polls.
 *
 * A local deferred rather than `Promise.withResolvers`, which needs
 * `lib: es2024`; raising this package's target for a sleep would be a
 * per-package divergence for no benefit.
 */
function sleep(ms: number): Promise<void> {
  let wake!: () => void;
  const waited = new Promise<void>((resolve) => {
    wake = resolve;
  });
  setTimeout(() => wake(), ms);
  return waited;
}

function requireFamily(value: string | undefined): ModelFamilyId {
  if (!value) {
    throw new CliError('missing_argument', 'a model family is required', {
      path: 'family',
      detail: { expected: [...MODEL_FAMILIES] },
    });
  }
  if (!isModelFamilyId(value)) {
    throw new CliError('unknown_model_family', `unknown model family: ${value}`, {
      path: 'family',
      detail: { expected: [...MODEL_FAMILIES] },
    });
  }
  return value;
}

function requireQuant(family: ModelFamilyId, value: string | undefined): ModelQuant {
  const catalog = MODEL_CATALOG[family];
  const requested = value ?? 'bf16';
  const offer = catalog.quants.find((candidate) => candidate.quant === requested);
  if (!offer) {
    throw new CliError('unknown_quant', `${family} has no quantization ${requested}`, {
      path: '--quant',
      detail: { offered: catalog.quants.map((candidate) => candidate.quant) },
    });
  }
  if (offer.status === 'unsupported') {
    throw new CliError(
      'quant_unsupported',
      `${family} does not support ${requested}: ${offer.note}`,
      { path: '--quant' },
    );
  }
  // The catalog lookup above succeeded, so `requested` is one of this
  // family's offered quants.
  return offer.quant;
}

/** Catalog, install state and eligibility for every family. */
export async function modelsList(options: ModelsOptions = {}): Promise<number> {
  const report = await preflight();
  const models = [];
  for (const family of MODEL_FAMILIES) {
    const catalog = MODEL_CATALOG[family];
    models.push({
      family,
      displayName: catalog.displayName,
      weights: `${catalog.weightsRepo}@${catalog.weightsRevision}`,
      code: `${catalog.codeRepo}@${catalog.codeRevision}`,
      license: catalog.license.id,
      commercialUseReviewRequired: catalog.license.commercialUseReviewRequired,
      requiresUserHfToken: catalog.requiresUserHfToken,
      cameras: catalog.cameras,
      capabilities: catalog.capabilities,
      textTasks: catalog.textTasks,
      approxDiskGiB: Math.round((catalog.approxDiskBytes / 1024 ** 3) * 10) / 10,
      remoteOnly: catalog.remoteOnly,
      state: await installState(family),
      quants: report.eligibility.filter((entry) => entry.family === family),
    });
  }
  emit({
      schema: 'simforge.models-list/v1',
      observed: report.observed,
      localExecution: report.localExecution,
      models,
      vault: await vaultStatus(),
    }, { pretty: options.pretty ?? false });
  return 0;
}

export type ModelsInstallOptions = ModelsOptions & {
  family: string | undefined;
  quant?: string;
  /**
   * Accept the weights licence (and a gated sidecar's licence). Required:
   * the CLI cannot show a licence dialog, so acceptance must be explicit on
   * the command line rather than implied by running the command.
   */
  acceptLicense?: boolean;
  /** Wait for the transfer to finish instead of returning once it starts. */
  wait?: boolean;
};

export async function modelsInstall(options: ModelsInstallOptions): Promise<number> {
  const family = requireFamily(options.family);
  const quant = requireQuant(family, options.quant);
  const catalog = MODEL_CATALOG[family];
  const entry = await lockEntry(family);

  if (!options.acceptLicense) {
    // Refuse rather than proceed: the licence texts, the gated sidecar and the
    // unresolved commercial-use question are exactly what the user must see
    // before 22-72 GB moves.
    emit({
        schema: 'simforge.models-install-refusal/v1',
        error: 'license_acceptance_required',
        family,
        license: {
          id: entry.weights.license,
          licenseBlobSha: entry.weights.licenseBlobSha,
          commercialUseReviewRequired: catalog.license.commercialUseReviewRequired,
          cardConflictNote: catalog.license.cardConflictNote,
        },
        gatedSidecars: entry.sidecars
          .filter((sidecar) => sidecar.gated !== false)
          .map((sidecar) => ({
            repo: sidecar.repo,
            revision: sidecar.revision,
            license: sidecar.license,
            acceptAt: `https://huggingface.co/${sidecar.repo}`,
          })),
        hint: 'review the licence, then re-run with --accept-license',
      }, { pretty: options.pretty ?? false });
    return 2;
  }

  const token = process.env.HF_TOKEN?.trim() ?? process.env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (token) await storeHfToken(token);

  try {
    await startInstall({
      family,
      quant,
      acceptLicense: true,
      acceptSidecarLicense: true,
    });
  } catch (error) {
    // The store's refusals (`hf_token_required`,
    // `license_acceptance_required`, `install_in_progress`) carry a `code`
    // and sometimes a `detail`; anything else is an unexpected failure.
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'install_failed';
    const detail =
      error && typeof error === 'object' && 'detail' in error
        ? (error.detail as Record<string, unknown>)
        : undefined;
    throw new CliError(code, error instanceof Error ? error.message : String(error), { detail });
  }

  let state = await installState(family);
  if (options.wait) {
    // Poll the shared engine's state rather than holding the transfer's own
    // promise: the same loop then works whether this process started the
    // install or is attaching to one the app began.
    while (state.state === 'downloading' || state.state === 'verifying') {
      await sleep(1000);
      state = await installState(family);
    }
  }

  const layout = installLayout(family, entry.weights.revision);
  emit({
      schema: 'simforge.models-install/v1',
      family,
      quant,
      revision: entry.weights.revision,
      checkpointDigest: entry.weights.checkpointDigest,
      root: layout.root,
      state,
      record: await installRecord(family),
    }, { pretty: options.pretty ?? false });
  return state.state === 'error' ? 2 : 0;
}

export type ModelsVerifyOptions = ModelsOptions & {
  family: string | undefined;
  /** Re-stream and re-hash every shard rather than checking sizes. */
  deep?: boolean;
};

export async function modelsVerify(options: ModelsVerifyOptions): Promise<number> {
  const family = requireFamily(options.family);
  const result = await verifyInstall(family, { deep: options.deep ?? false });
  emit({
      schema: 'simforge.models-verify/v1',
      family,
      deep: options.deep ?? false,
      ...result,
    }, { pretty: options.pretty ?? false });
  return result.ok ? 0 : 2;
}

export type ModelsUninstallOptions = ModelsOptions & {
  family: string | undefined;
  purgeSharedCache?: boolean;
};

export async function modelsUninstall(options: ModelsUninstallOptions): Promise<number> {
  const family = requireFamily(options.family);
  const result = await uninstall(family, { purgeSharedCache: options.purgeSharedCache ?? false });
  emit({
      schema: 'simforge.models-uninstall/v1',
      family,
      purgeSharedCache: options.purgeSharedCache ?? false,
      ...result,
      state: await installState(family),
    }, { pretty: options.pretty ?? false });
  return 0;
}

export type ModelsCancelOptions = ModelsOptions & {
  family: string | undefined;
  discardPartials?: boolean;
};

export async function modelsCancel(options: ModelsCancelOptions): Promise<number> {
  const family = requireFamily(options.family);
  const state = await cancelInstall(family, options.discardPartials ?? false);
  emit({ schema: 'simforge.models-cancel/v1', family, state }, { pretty: options.pretty ?? false });
  return 0;
}

export type ModelsPreflightOptions = ModelsOptions & {
  family?: string;
  /** Reserve renderer VRAM headroom: the closed-loop co-residency question. */
  reserveRenderer?: boolean;
};

export async function modelsPreflight(options: ModelsPreflightOptions): Promise<number> {
  const family = options.family ? requireFamily(options.family) : undefined;
  const report = await preflight({
    families: family ? [family] : undefined,
    reserveRenderer: options.reserveRenderer ?? false,
  });
  emit(report, { pretty: options.pretty ?? false });
  // Exit 2 when a specific family was asked about and cannot execute here.
  // Without a family the report is informational: a machine with no eligible
  // profile is a valid remote-execution host, not an error.
  if (family && !report.eligibility.some((entry) => entry.executionEligible)) return 2;
  return 0;
}

export type ModelsCacheOptions = ModelsOptions & {
  /** Actually delete unreferenced cache entries. Default is a dry run. */
  reclaim?: boolean;
};

export async function modelsCache(options: ModelsCacheOptions): Promise<number> {
  const dryRun = !options.reclaim;
  const result = await reclaimCache({ dryRun });
  emit({ schema: 'simforge.models-cache/v1', dryRun, ...result }, { pretty: options.pretty ?? false });
  return 0;
}

export type ModelsPrepareOptions = ModelsOptions & {
  family: string | undefined;
  quant?: string;
  /** Build flash-attn instead of using the SDPA fallback. Requires nvcc. */
  flashAttn?: boolean;
  /** Discard an existing venv and code checkout and rebuild. */
  force?: boolean;
};

/**
 * Provision the isolated Python runtime for an installed family.
 *
 * Separate from `install` on purpose: a user who only wants weights for cloud
 * execution should not be made to build a torch/CUDA environment, and a venv
 * failure must never discard verified weights.
 */
export async function modelsPrepare(options: ModelsPrepareOptions): Promise<number> {
  const family = requireFamily(options.family);
  const quant = requireQuant(family, options.quant);
  const steps: { step: string; detail: string }[] = [];
  try {
    const record = await prepareRuntime({
      family,
      quant,
      flashAttn: options.flashAttn ?? false,
      force: options.force ?? false,
      onProgress: (progress) => {
        steps.push(progress);
        // Progress goes to stderr: stdout stays one JSON document.
        process.stderr.write(`${JSON.stringify(progress)}\n`);
      },
    });
    emit(
      { schema: 'simforge.models-prepare/v1', family, quant, runtime: record },
      { pretty: options.pretty ?? false },
    );
    return 0;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'prepare_failed';
    const step =
      error && typeof error === 'object' && 'step' in error ? error.step : null;
    const detail =
      error && typeof error === 'object' && 'detail' in error
        ? (error.detail as Record<string, unknown>)
        : undefined;
    throw new CliError(code, error instanceof Error ? error.message : String(error), {
      detail: { ...(detail ?? {}), step, completedSteps: steps.map((entry) => entry.step) },
    });
  }
}

/** The prepared runtime for a family, or null when none exists yet. */
export async function modelsRuntime(options: ModelsOptions & { family: string | undefined }): Promise<number> {
  const family = requireFamily(options.family);
  const record = await readRuntimeRecord(family);
  emit(
    { schema: 'simforge.models-runtime/v1', family, prepared: record !== null, runtime: record },
    { pretty: options.pretty ?? false },
  );
  return record === null ? 2 : 0;
}

/** The committed lock, for review and for comparing against a machine. */
export async function modelsLock(options: ModelsOptions = {}): Promise<number> {
  emit(await loadModelLock(), { pretty: options.pretty ?? false });
  return 0;
}
