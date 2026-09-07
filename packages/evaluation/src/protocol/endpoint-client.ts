/**
 * HTTP client for the model engine's `simforge.policy-endpoint/v2` facade —
 * the open-loop path used identically by the desktop model-run worker and the
 * cloud worker CLI, so local and remote open loop share one code path.
 *
 * `POST /invoke` carries one item; `GET /healthz` reports the loaded model's
 * identity and capabilities. Two failure classes are kept strictly apart:
 *
 * - A typed refusal (`ok: false` with an `error.code`) is a *per-item* verdict
 *   the caller records and moves on from — a camera set the family does not
 *   accept, missing driving fields, an unsupported op.
 * - An HTTP or transport fault is an engine/infrastructure failure that fails
 *   the attempt.
 *
 * Both `http://host:port` and unix sockets (`unix:/path/to.sock`) are
 * supported so the same client reaches a co-located engine without a TCP port.
 */

import { request as httpRequest } from 'node:http';

export const ENDPOINT_PROTOCOL = 'simforge.policy-endpoint/v2';

export interface EndpointCapabilities {
  readonly cameras?: {
    readonly required?: readonly number[];
    readonly variable?: boolean;
    readonly default?: readonly number[];
    readonly max?: number;
  };
  readonly nav?: boolean;
  readonly vqa?: boolean;
  readonly meta_actions?: boolean;
  readonly autolabel?: boolean;
  readonly grounding?: boolean;
}

export interface EndpointHealth {
  readonly ok: boolean;
  readonly status?: string;
  readonly family?: string;
  readonly revision?: string;
  readonly quant?: string;
  readonly checkpoint_digest?: string;
  readonly camera_profile?: string;
  readonly capabilities?: EndpointCapabilities;
  readonly supports?: readonly string[];
  readonly loaded?: boolean;
  readonly attn?: string;
  readonly torch?: string;
  readonly cuda?: string;
  readonly gpu?: unknown;
}

export interface InvokeObservation {
  readonly cameras: readonly {
    readonly camera_id: number;
    readonly frames?: readonly string[];
    readonly frames_paths?: readonly string[];
    readonly encoding: 'raw' | 'raw-b64' | 'jpeg' | 'png';
    readonly width?: number;
    readonly height?: number;
  }[];
  readonly ego_history_xyz?: readonly (readonly number[])[];
  readonly ego_history_rot?: readonly (readonly (readonly number[])[])[];
  readonly ego_history_t_s?: readonly number[];
  readonly nav_text?: string | null;
}

export interface InvokeRequest {
  readonly runId: string;
  readonly attemptId: string | null;
  readonly index: number;
  readonly seed: number;
  readonly task: 'act' | 'text';
  readonly obs: InvokeObservation;
  readonly params: Record<string, unknown>;
}

export interface InvokeSuccess {
  readonly ok: true;
  readonly result: {
    readonly trajectories?: readonly (readonly (readonly number[])[])[];
    readonly rotations?: readonly (readonly (readonly number[])[])[] | null;
    readonly trajectory_rot?: readonly (readonly (readonly number[])[])[] | null;
    readonly horizon_s?: number;
    readonly dt_s?: number;
    readonly frame?: string;
    readonly reasoning?: readonly (string | null)[];
    readonly text?: string | null;
    readonly fields?: Record<string, unknown> | null;
    readonly timings?: Record<string, number>;
    readonly vram?: Record<string, unknown>;
    readonly rng_provenance?: Record<string, unknown>;
    readonly model?: Record<string, unknown>;
    readonly time_base_warning?: string | null;
  };
}

export interface InvokeRefusal {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly string[];
    readonly required_cameras?: readonly number[] | null;
    readonly detail?: Record<string, unknown>;
  };
}

export type InvokeResponse = InvokeSuccess | InvokeRefusal;

/** Transport/engine fault (never a per-item verdict). */
export class EndpointTransportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EndpointTransportError';
  }
}

export interface EndpointTarget {
  /** `http://127.0.0.1:8080` or `unix:/run/engine.sock`. */
  readonly url: string;
  readonly timeoutMs?: number;
}

interface ParsedTarget {
  readonly socketPath: string | null;
  readonly origin: string;
  readonly basePath: string;
}

function parseTarget(url: string): ParsedTarget {
  if (url.startsWith('unix:')) {
    const [socket, suffix] = url.slice('unix:'.length).split('!');
    return { socketPath: socket!, origin: 'http://localhost', basePath: suffix ?? '' };
  }
  const parsed = new URL(url);
  const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return { socketPath: null, origin: parsed.origin, basePath };
}

async function requestJson(
  target: EndpointTarget,
  method: 'GET' | 'POST',
  routePath: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const { socketPath, origin, basePath } = parseTarget(target.url);
  const timeoutMs = target.timeoutMs ?? 600_000;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (payload !== undefined) headers['content-type'] = 'application/json';

  if (socketPath) {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
    const clientRequest = httpRequest(
      { socketPath, path: `${basePath}${routePath}`, method, headers, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 500, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    clientRequest.once('timeout', () => {
      clientRequest.destroy(new EndpointTransportError('endpoint_invoke_timeout', `invoke exceeded ${timeoutMs}ms`));
    });
    clientRequest.once('error', (error) => {
      reject(
        error instanceof EndpointTransportError
          ? error
          : new EndpointTransportError('endpoint_unreachable', error.message),
      );
    });
    clientRequest.end(payload);
    return promise;
  }

  let response: Response;
  try {
    response = await fetch(`${origin}${basePath}${routePath}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes('timed out') || message.includes('abort') ? 'endpoint_invoke_timeout' : 'endpoint_unreachable';
    throw new EndpointTransportError(code, `${routePath}: ${message}`);
  }
  return { status: response.status, text: await response.text() };
}

/** `GET /healthz`; the identity gate before any GPU second is spent. */
export async function endpointHealth(target: EndpointTarget): Promise<EndpointHealth> {
  const { status, text } = await requestJson(target, 'GET', '/healthz', undefined);
  if (status >= 400) {
    throw new EndpointTransportError('endpoint_unhealthy', `healthz returned ${status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as EndpointHealth;
  } catch (error) {
    throw new EndpointTransportError('endpoint_protocol_error', `healthz returned non-JSON: ${String(error)}`);
  }
}

/**
 * `POST /invoke` for one item.
 *
 * A typed refusal is returned (not thrown) whether the engine sent it with
 * HTTP 200 or 400 — the wire allows both and it is the same verdict.
 */
export async function endpointInvoke(target: EndpointTarget, body: InvokeRequest): Promise<InvokeResponse> {
  const { status, text } = await requestJson(target, 'POST', '/invoke', body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EndpointTransportError(
      'endpoint_protocol_error',
      `invoke returned ${status} with non-JSON body: ${text.slice(0, 500)}`,
    );
  }
  const document = parsed as Partial<InvokeSuccess & InvokeRefusal>;
  if (document.ok === false && document.error) return { ok: false, error: document.error };
  if (status >= 400) {
    throw new EndpointTransportError('endpoint_invoke_failed', `invoke returned ${status}: ${text.slice(0, 500)}`);
  }
  if (document.ok !== true || !document.result) {
    throw new EndpointTransportError('endpoint_protocol_error', `invoke returned an unrecognised document: ${text.slice(0, 300)}`);
  }
  return { ok: true, result: document.result };
}

/**
 * Identity a caller can require of the loaded engine. Every field is
 * optional because the desktop registry pins `family`/`quant`/
 * `checkpointDigest` while a cloud job pins the HF `revision`; only the
 * fields actually supplied are compared.
 */
export interface ModelIdentity {
  readonly family?: string | null;
  readonly revision?: string | null;
  readonly quant?: string | null;
  readonly checkpointDigest?: string | null;
}

/**
 * Refuse before inference when the loaded engine is not the requested model.
 *
 * Returns the mismatching fields; an empty array means the identity matches.
 * A run that silently used a different revision would produce numbers
 * attributed to the wrong model.
 */
export function modelIdentityMismatch(health: EndpointHealth, expected: ModelIdentity): string[] {
  const actual: Record<string, unknown> = {
    family: health.family,
    revision: health.revision,
    quant: health.quant,
    checkpointDigest: health.checkpoint_digest,
  };
  return Object.entries(expected)
    .filter(([key, value]) => value && String(actual[key] ?? '') !== String(value))
    .map(([key, value]) => `${key}: engine reports ${String(actual[key] ?? 'unknown')}, job requested ${String(value)}`);
}

/**
 * Check a camera set against the engine's declared capabilities.
 *
 * Returns a human-readable violation or `null`. The engine enforces this too;
 * checking here means an impossible run is refused before it is dispatched.
 */
export function cameraSetViolation(health: EndpointHealth, cameraIds: readonly number[]): string | null {
  const cameras = health.capabilities?.cameras;
  if (!cameras) return null;
  const requested = [...cameraIds].sort((a, b) => a - b);
  const required = [...(cameras.required ?? [])].sort((a, b) => a - b);
  if (required.length > 0 && !cameras.variable) {
    if (requested.length !== required.length || required.some((id, index) => id !== requested[index])) {
      return `${health.family ?? 'model'} requires cameras [${required.join(', ')}]; input supplies [${requested.join(', ')}]`;
    }
  }
  if (required.length > 0 && cameras.variable) {
    const unmet = required.filter((id) => !requested.includes(id));
    if (unmet.length > 0) return `input is missing required cameras [${unmet.join(', ')}]`;
  }
  if (cameras.max !== undefined && requested.length > cameras.max) {
    return `input supplies ${requested.length} cameras, endpoint accepts ${cameras.max}`;
  }
  return null;
}
