/**
 * No-silent-fallback policy (docs/engineering/no-silent-fallbacks.md):
 * missing, failed or unsupported data that would change render output fails
 * the job with a machine code naming what is missing. A substitution is only
 * allowed when the job input requests it, and is then recorded in the
 * manifest (`substitutions`, gated by CONTROL_FEATURE_RENDER_SUBSTITUTIONS).
 */

/** Codes this policy reports: `native_*` (Bevy path), `carla_*`, `render_*` (engine-neutral). */
import { z } from 'zod';
import { RENDER_SUBSTITUTION_KINDS } from '@simforge-oss/scenario';

export type RenderInputErrorCode = `native_${string}` | `carla_${string}` | `render_${string}`;

export const RENDER_INPUT_ERROR_CODE = /^(?:native|carla|render)_[a-z0-9_]+$/u;

/** A render refused because an input it needs is missing, invalid or unsupported. Never retryable. */
export class RenderInputError extends Error {
  readonly retryable = false;
  constructor(
    readonly code: RenderInputErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    if (!RENDER_INPUT_ERROR_CODE.test(code)) throw new Error(`invalid render input error code ${code}`);
    super(message);
    this.name = 'RenderInputError';
  }
}

/**
 * The native service prefixes policy errors with `[native_code] `. Recover
 * the code so the worker reports it (non-retryable) instead of a generic
 * execution failure that would be retried on another worker.
 */
export function renderInputErrorFromServiceMessage(message: string): RenderInputError | undefined {
  const match = /^\[((?:native|carla|render)_[a-z0-9_]+)\]\s*(.*)$/su.exec(message);
  if (!match) return undefined;
  return new RenderInputError(match[1] as RenderInputErrorCode, match[2] || message);
}

/** One intended, requested substitution as a manifest records it. */
export const RenderSubstitutionSchema = z.strictObject({
  /** A kind the intent's `allowSubstitutions` lists. */
  kind: z.enum(RENDER_SUBSTITUTION_KINDS),
  /** The subject (actor id, sensor id, `map`, ...). */
  subject: z.string().min(1).max(256),
  requested: z.string().min(1).max(512),
  rendered: z.string().min(1).max(512),
  /** The job-input field that allowed it. */
  allowedBy: z.literal('allowSubstitutions'),
  details: z.record(z.string(), z.json()).optional(),
});
export type RenderSubstitution = z.infer<typeof RenderSubstitutionSchema>;
