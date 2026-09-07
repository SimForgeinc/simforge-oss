/**
 * The error raised when the machine cannot do what was asked.
 *
 * Distinct from a refusal, which is about the *input*: a capability error says the host is
 * missing a prerequisite, has one at the wrong revision, or has one whose bytes are not the
 * bytes we pinned. The compute control plane classifies it as a non-retryable
 * `capability_error`, because re-dispatching the same job to the same image would burn the
 * same credits for the same answer.
 *
 * It lives in its own module so the low-level pieces (encoder resolution) and the high-level
 * ones (render tier, reconstruction) can raise the same type without importing each other.
 */
export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}
