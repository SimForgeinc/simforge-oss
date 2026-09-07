import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { decode, encode } from '@msgpack/msgpack';

const HEADER_BYTES = 4;
const RECORD_HEADER_BYTES = 128;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** Wire protocol this client speaks (`renderer/service/src/proto.rs`). */
export const NATIVE_SERVICE_PROTOCOL = 5;

export interface NativeFrameRecord {
  readonly sensorId: string;
  readonly pass: string;
  readonly offset: number;
  readonly len: number;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly tickId: number;
  /** CRC32 (IEEE) of the payload bytes, 8-char lowercase hex. */
  readonly digest: string;
}

/**
 * Identity of the single GPU submission every payload of a response was
 * copied from (`render_core::engine::FrameIdentity`).
 */
export interface NativeFrameIdentity {
  readonly simTick: number;
  readonly sceneRevision: number;
  readonly rigRevision: number;
  readonly generation: number;
}

/**
 * One service reply. The common envelope is typed; every operation-specific
 * field (`coverage`, `export`, …) is reachable without a copy or cast, but
 * only as `unknown` so callers validate what they consume.
 */
export interface NativeServiceResponse {
  readonly i: number;
  readonly op: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly protocol?: number;
  readonly shm?: { readonly path: string; readonly size_bytes: number; readonly meta_bytes: number };
  readonly frame?: Partial<NativeFrameIdentity>;
  readonly frames?: readonly NativeFrameRecord[];
  readonly server_ms?: number;
  readonly [field: string]: unknown;
}

export interface NativeBundleResponse extends NativeServiceResponse {
  readonly frame: NativeFrameIdentity;
  readonly frames: readonly NativeFrameRecord[];
}

/** An RPC outlived its deadline; the connection it was on is gone. */
export class NativeServiceTimeoutError extends Error {
  override readonly name = 'TimeoutError';

  constructor(op: string, timeoutMs: number) {
    super(`native render service ${op} timed out after ${timeoutMs} ms`);
  }
}

export interface NativeServiceConnectOptions {
  readonly signal?: AbortSignal;
  readonly attempts?: number;
  /** Deadline for the `hello` handshake; a wedged service fails here instead of hanging. */
  readonly helloTimeoutMs?: number;
}

/** How long `close()` waits for the service to acknowledge before dropping the socket. */
const CLOSE_TIMEOUT_MS = 5_000;

const promiseConstructor = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
};

export class NativeServiceClient {
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, { resolve: (value: NativeServiceResponse) => void; reject: (reason?: unknown) => void }>();
  #buffer = Buffer.alloc(0);
  #sequence = 0;
  #shmPath = '';
  /** Set once the connection is unusable; every later `rpc` rejects with it. */
  #failure: Error | undefined;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#consume(chunk));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('native render service socket closed')));
  }

  /**
   * Connects to the service endpoint (`--socket`: Unix socket path or, on
   * Windows, a `\\.\pipe\` name). A refused/missing endpoint right after the
   * ready signal is retried briefly; anything else is the caller's error.
   */
  static async connect(endpoint: string, options: NativeServiceConnectOptions = {}): Promise<NativeServiceClient> {
    const attempts = options.attempts ?? 40;
    let socket: net.Socket | undefined;
    for (let attempt = 1; ; attempt += 1) {
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('native render aborted');
      const candidate = net.createConnection(endpoint);
      try {
        await once(candidate, 'connect', { signal: options.signal });
        socket = candidate;
        break;
      } catch (error) {
        candidate.destroy();
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= attempts || (code !== 'ECONNREFUSED' && code !== 'ENOENT' && code !== 'EAGAIN')) throw error;
        await delay(50);
      }
    }
    const client = new NativeServiceClient(socket);
    let hello: NativeServiceResponse;
    try {
      hello = await client.rpc({ op: 'hello' }, options.helloTimeoutMs);
    } catch (error) {
      client.#fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (hello.protocol !== NATIVE_SERVICE_PROTOCOL || !hello.shm?.path) {
      await client.close();
      throw new Error(`native render service protocol ${String(hello.protocol)}; this client speaks ${NATIVE_SERVICE_PROTOCOL}`);
    }
    client.#shmPath = hello.shm.path;
    return client;
  }

  /** `render_bundle`: one submission of the resident scene, identity-stamped. */
  async renderBundle(body: Readonly<Record<string, unknown>>): Promise<NativeBundleResponse> {
    const value = await this.rpc({ ...body, op: 'render_bundle' });
    const { frame, frames } = value;
    if (
      typeof frame?.simTick !== 'number'
      || typeof frame.sceneRevision !== 'number'
      || typeof frame.rigRevision !== 'number'
      || typeof frame.generation !== 'number'
      || !Array.isArray(frames)
    ) {
      throw new Error('native render service bundle response is missing its frame identity');
    }
    return { ...value, frame: frame as NativeFrameIdentity, frames };
  }

  /**
   * Sends one request. With `timeoutMs`, a late reply is not waited for: the
   * connection is failed, every in-flight call rejects, and this one rejects
   * with a `NativeServiceTimeoutError`, so nothing dangles on a wedged service.
   */
  async rpc(body: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<NativeServiceResponse> {
    if (this.#failure) throw this.#failure;
    const i = ++this.#sequence;
    const payload = Buffer.from(encode({ i, ...body }));
    if (payload.byteLength > MAX_FRAME_BYTES) throw new Error('native service request exceeds 64 MiB');
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32LE(payload.byteLength);
    const { promise: response, resolve, reject } = promiseConstructor.withResolvers<NativeServiceResponse>();
    this.#pending.set(i, { resolve, reject });
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => this.#fail(new NativeServiceTimeoutError(String(body.op), timeoutMs)), timeoutMs);
    this.#socket.write(Buffer.concat([header, payload]));
    let value: NativeServiceResponse;
    try {
      value = await response;
    } finally {
      clearTimeout(timer);
    }
    if (!value.ok) throw new Error(value.error ?? `native service ${value.op} failed`);
    return value;
  }

  async readFrame(frame: NativeFrameRecord): Promise<Buffer> {
    if (!Number.isSafeInteger(frame.offset) || !Number.isSafeInteger(frame.len) || frame.len < 0) {
      throw new Error('native service returned an invalid shared-memory frame range');
    }
    const handle = await fs.open(this.#shmPath, 'r');
    try {
      const bytes = Buffer.allocUnsafe(frame.len);
      const { bytesRead } = await handle.read(bytes, 0, frame.len, frame.offset + RECORD_HEADER_BYTES);
      if (bytesRead !== frame.len) throw new Error(`short shared-memory read: ${bytesRead}/${frame.len}`);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  /**
   * Asks the service to shut down, then drops the socket. Bounded: a service
   * that never acknowledges does not hold the caller; process teardown owns
   * the final cleanup either way.
   */
  async close(): Promise<void> {
    if (this.#failure) return;
    try { await this.rpc({ op: 'close' }, CLOSE_TIMEOUT_MS); } catch { /* the socket is dropped below regardless */ }
    this.#fail(new Error('native render service client closed'));
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= HEADER_BYTES) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) return this.#fail(new Error(`native service response exceeds ${MAX_FRAME_BYTES} bytes`));
      if (this.#buffer.byteLength < HEADER_BYTES + length) return;
      const payload = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      const value = decode(payload) as NativeServiceResponse;
      const pending = this.#pending.get(value.i);
      if (!pending) return this.#fail(new Error(`native service returned unknown request id ${value.i}`));
      this.#pending.delete(value.i);
      pending.resolve(value);
    }
  }

  #fail(error: Error): void {
    if (!this.#failure) this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#socket.destroy();
  }
}

export function stripRgbaPadding(bytes: Buffer, width: number, height: number): Buffer {
  const rowBytes = width * 4;
  const stride = Math.ceil(rowBytes / 256) * 256;
  if (bytes.byteLength !== stride * height) {
    throw new Error(`unexpected RGBA payload size ${bytes.byteLength}; expected ${stride * height}`);
  }
  if (stride === rowBytes) return bytes;
  const packed = Buffer.allocUnsafe(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    bytes.copy(packed, row * rowBytes, row * stride, row * stride + rowBytes);
  }
  return packed;
}
