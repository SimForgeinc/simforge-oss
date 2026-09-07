import { z } from "zod";
import { MODEL_FAMILIES, type ModelFamilyId, type ModelQuant } from "./catalog";

/**
 * Request bodies for the model-store routes.
 *
 * The enums are written as literal tuples rather than derived from the
 * catalog arrays, because a zod enum built from a `readonly string[]` widens
 * to `string` and would push a cast into every route handler. The two
 * assertions below make a divergence from the catalog a type error here
 * instead of a runtime surprise in a handler.
 */
const FamilyEnum = z.enum(["alpamayo-1", "alpamayo-1.5", "alpamayo-2-super"]);
const QuantEnum = z.enum(["bf16", "nf4", "fp8"]);

const _familiesMatchCatalog: readonly ModelFamilyId[] = FamilyEnum.options;
const _quantsAreModelQuants: readonly ModelQuant[] = QuantEnum.options;
void _familiesMatchCatalog;
void _quantsAreModelQuants;
if (FamilyEnum.options.length !== MODEL_FAMILIES.length) {
  throw new Error("model-store request enum is out of sync with MODEL_FAMILIES");
}

export const InstallRequestSchema = z.object({
  family: FamilyEnum,
  quant: QuantEnum,
  /**
   * Supplied once, stored in the OS credential vault, and never echoed back,
   * logged, or written into the install record. Only a gated sidecar repo
   * ever receives it.
   */
  hfToken: z.string().min(1).optional(),
  /** The weights licence text must be shown and accepted before any bytes move. */
  acceptLicense: z.literal(true),
  /** Required only for a family whose sidecar carries its own licence. */
  acceptSidecarLicense: z.literal(true).optional(),
});

export const InstallControlSchema = z.object({
  family: FamilyEnum,
  quant: QuantEnum.optional(),
  /** Cancel only: also delete the partially downloaded files. */
  discardPartials: z.boolean().optional(),
});

export const VerifyRequestSchema = z.object({
  family: FamilyEnum,
  /** Re-stream and re-hash every shard instead of checking sizes. */
  deep: z.boolean().optional(),
});

export const TokenRequestSchema = z.object({
  token: z.string().min(1),
});

export const ReclaimRequestSchema = z.object({
  dryRun: z.boolean().optional(),
});

export type InstallRequest = z.infer<typeof InstallRequestSchema>;
export type InstallControlRequest = z.infer<typeof InstallControlSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
