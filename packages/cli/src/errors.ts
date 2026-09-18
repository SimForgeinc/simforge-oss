import { ProtocolDecodeError, StudioHostRequestError } from '@simforge-oss/studio-host';
import { toStructuredError as toStructuredCompilerError, type StructuredError } from '@simforge-oss/compiler';

export * from '@simforge-oss/compiler';

/**
 * Coerce anything thrown into the CLI's `{code, reason, detail}` shape,
 * including the two typed failures that only exist on the far side of the
 * Studio host boundary.
 *
 * Without this every host failure arrived as `internal_error` with the class
 * name glued to the front of the message — `internal_error: StudioHostRequestError:
 * That scenario no longer exists.` for a document id that does not exist, and
 * `internal_error: ProtocolDecodeError: response: expected object, got null`
 * for a host whose answer this client's decoder refuses. Both are perfectly
 * diagnosable on the wire and neither is internal: the route already sent
 * `{"error":"document_not_found"}` with a 404, and the decoder already knows
 * which field disagreed. The CLI's primary caller is an unattended repair loop,
 * so `internal_error` is the one code it cannot act on.
 */
export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof StudioHostRequestError) {
    return { code: error.code, reason: error.message, detail: { status: error.status } };
  }
  if (error instanceof ProtocolDecodeError) {
    return {
      code: 'host_contract_mismatch',
      path: error.path,
      reason: `The Studio host answered ${error.path} with something this client does not accept: expected ${error.expected}. Check that the host and this client are the same build.`,
      detail: { expected: error.expected, received: error.received ?? null },
    };
  }
  return toStructuredCompilerError(error);
}
