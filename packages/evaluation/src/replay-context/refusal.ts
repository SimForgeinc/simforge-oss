/**
 * Typed refusals.
 *
 * The product promise is that an input we cannot evaluate is refused with the exact reason,
 * never quietly downgraded into a plausible-looking number. A refusal therefore carries a
 * machine-readable list of dotted field paths, which is what the desktop and the web portal
 * render ("this clip needs per-camera intrinsics and an ego history") and what
 * `reconstruct.nurec` returns to the compute control plane as a non-retryable `input_error`.
 *
 * The counterpart promise: a refusal is not the end of the road. `alternatives` names what
 * the input *can* still do — for a video-only upload that is the frame-only text tasks
 * (VQA / meta-actions / auto-labelling), explicitly labelled as not a driving evaluation.
 */

/**
 * The part of a schema issue a refusal needs. Declared structurally rather than imported from
 * the validator's internals: this shape is stable, and a refusal should not be coupled to a
 * particular zod release's type layout.
 */
export interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Worker-side error codes, agreed with the compute owner (`packages/shared/src/compute-jobs.ts`). */
export type WorkerErrorCode = 'input_error' | 'capability_error' | 'storage_error' | 'internal';

export interface MissingField {
  /** Dotted path into the offending document, e.g. `cameras[0].intrinsics`. */
  readonly path: string;
  /** What that field must contain, in the user's terms. */
  readonly requirement: string;
}

export interface Refusal {
  readonly code: 'missing_fields' | 'unsupported_input' | 'integrity_failed';
  readonly message: string;
  readonly missing: readonly MissingField[];
  /** What this input is still good for, if anything. */
  readonly alternatives: readonly string[];
}

/** A refusal raised as an exception, so importers can fail fast without an out-param. */
export class RefusalError extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = 'RefusalError';
    this.refusal = refusal;
  }
}

/** Text tasks a frame-only clip can still be used for. Never a driving score. */
export const FRAME_ONLY_ALTERNATIVES: readonly string[] = [
  'alpamayo.text with task=vqa (Alpamayo 1.5 / 2) — visual question answering over the uploaded frames',
  'alpamayo.text with task=meta_actions (Alpamayo 2) — discrete manoeuvre labels',
  'alpamayo.text with task=autolabel (Alpamayo 2) — structured scene annotation',
  'These are frame analysis tasks and produce no trajectory, no ADE/FDE and no driving score.',
];

/**
 * Render a zod issue path as the dotted/bracketed form used in refusals, so a UI and a log
 * line agree on how to name a field.
 */
export function formatFieldPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
      continue;
    }
    out += out.length === 0 ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/**
 * Turn a failed schema parse into a refusal. Schema violations and absent sidecars are the
 * same thing from the user's point of view — the document does not carry what evaluation
 * needs — so they get the same typed shape rather than a stack trace.
 */
export function refusalFromIssues(
  code: Refusal['code'],
  message: string,
  issues: readonly SchemaIssue[],
  alternatives: readonly string[] = [],
): Refusal {
  const missing = issues.map((issue) => ({
    path: formatFieldPath(issue.path) || '<document root>',
    requirement: issue.message,
  }));
  return { code, message, missing, alternatives };
}

/**
 * The JSON a worker prints on stdout before exiting non-zero. `retryable` is always false:
 * every refusal in this module is a statement about the input or the machine's
 * capabilities, and re-dispatching the same job would burn the same credits for the same
 * answer.
 */
export function workerErrorEnvelope(
  code: WorkerErrorCode,
  refusalOrMessage: Refusal | string,
): {
  readonly error: {
    readonly code: WorkerErrorCode;
    readonly retryable: false;
    readonly message: string;
    readonly fields?: readonly string[];
    readonly alternatives?: readonly string[];
  };
} {
  if (typeof refusalOrMessage === 'string') {
    return { error: { code, retryable: false, message: refusalOrMessage } };
  }
  return {
    error: {
      code,
      retryable: false,
      message: refusalOrMessage.message,
      fields: refusalOrMessage.missing.map((field) => field.path),
      ...(refusalOrMessage.alternatives.length > 0 ? { alternatives: refusalOrMessage.alternatives } : {}),
    },
  };
}
