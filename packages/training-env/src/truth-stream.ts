/**
 * TruthStream — the frozen world-session ground-truth wire.
 *
 * The native `WorldSession` publishes one `TruthFrame` per engine tick to every
 * subscriber, framed as `u32le byteLength || msgpack(TruthFrame)`. This module
 * is the client side of that contract: the document types, the framer and the
 * incremental decoder. Fan-out, bounded queues and drop-oldest backpressure
 * live in the native session (`TruthSubscription` on `WorldSession`).
 *
 * Determinism: frames are built purely from engine state — no wall clock, no
 * randomness — so two identical runs produce byte-identical streams.
 */

import { decode, encode } from '@msgpack/msgpack';

import type { ActorKind, Dims, SignalSnapshot } from '@simforge-oss/engine';
import type { ActorClass, SceneFrame } from '@simforge-oss/engine/scene-state';

/* ------------------------------------------------ world-session truth v1 */

/** Static actor identity carried beside the frozen scene-state.v1 frame. */
export interface TruthActor {
  readonly id: string;
  readonly class: ActorClass;
  readonly dims: { readonly l: number; readonly w: number; readonly h: number };
  /** XODR-local world-plane acceleration in m/s². */
  readonly accel: { readonly ax: number; readonly ay: number };
}

/**
 * Frozen world-session truth contract. One complete value is encoded into one
 * msgpack payload and one length-prefixed transport frame.
 */
export interface TruthFrame {
  readonly tick: number;
  readonly timeSec: number;
  readonly scene: SceneFrame;
  readonly signals: readonly SignalSnapshot[];
  readonly actors: readonly TruthActor[];
}

export interface TruthActorCatalogEntry {
  readonly kind: ActorKind;
  readonly dims: Dims;
}

export interface TruthSubscriptionStats {
  readonly queued: number;
  /** Cumulative frames discarded from this subscription by drop-oldest. */
  readonly dropped: number;
}

/** Default bounded frame count for one world-session subscriber. */
export const WORLD_TRUTH_QUEUE_CAPACITY = 256;

/** Encode one TruthFrame as `u32le byteLength || msgpack(TruthFrame)`. */
export function encodeTruthFrame(frame: TruthFrame): Uint8Array {
  const encoded = encode(frame);
  // @msgpack/msgpack 3.x returns Uint8Array in both Node and browsers. Copy
  // into our own Uint8Array so callers never depend on a runtime-specific
  // Buffer subclass or the encoder's backing-store offset.
  const payload = new Uint8Array(encoded.byteLength);
  payload.set(encoded);
  const framed = new Uint8Array(4 + payload.byteLength);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, true);
  framed.set(payload, 4);
  return framed;
}

/**
 * Incremental client-side decoder for the public truth-stream framing. It
 * accepts arbitrary transport chunks and returns every complete TruthFrame.
 */
export class TruthStreamClient {
  private buffered = new Uint8Array(0);

  push(chunk: Uint8Array): TruthFrame[] {
    if (chunk.byteLength > 0) {
      const incoming = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (this.buffered.byteLength === 0) {
        this.buffered = incoming.slice();
      } else {
        const combined = new Uint8Array(this.buffered.byteLength + incoming.byteLength);
        combined.set(this.buffered);
        combined.set(incoming, this.buffered.byteLength);
        this.buffered = combined;
      }
    }

    const frames: TruthFrame[] = [];
    let offset = 0;
    for (;;) {
      if (this.buffered.byteLength - offset < 4) break;
      const length = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset + offset,
        4,
      ).getUint32(0, true);
      if (length > 64 * 1024 * 1024) throw new Error(`truth frame of ${length} bytes exceeds 64 MiB`);
      if (this.buffered.byteLength - offset < length + 4) break;
      const payloadStart = offset + 4;
      frames.push(decode(this.buffered.subarray(payloadStart, payloadStart + length)) as TruthFrame);
      offset = payloadStart + length;
    }

    if (offset > 0) this.buffered = this.buffered.slice(offset);
    return frames;
  }
}
