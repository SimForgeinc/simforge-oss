/**
 * Host-neutral binding over the pinned SUMO 1.27.1 WebAssembly bridge
 * (`research/sumo-wasm/bridge/sumo_wasm_bridge.cpp`).
 *
 * WebAssembly is the worker runtime on purpose: its arithmetic is specified
 * bit for bit (IEEE-754 binary64 with no fused operations or x87 excess
 * precision, deterministic libm compiled into the module), so one module
 * digest yields the same trajectories on every CPU and operating system. A
 * native libsumo build would inherit the host compiler's FMA contraction,
 * libm and SIMD paths instead.
 */

/** Raw Emscripten exports of the bridge. */
export interface SumoWasmModule {
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _us_sumo_start(net: number, netLength: number, routes: number, routesLength: number, step: number, seed: number): number;
  _us_sumo_step(deltaSeconds: number): number;
  _us_sumo_upsert_external(
    id: number, kind: number, routeId: number, x: number, y: number,
    heading: number, speed: number, length: number, width: number,
  ): number;
  _us_sumo_remove(id: number): number;
  _us_sumo_state_pointer(): number;
  _us_sumo_state_count(): number;
  _us_sumo_signal_state_pointer(): number;
  _us_sumo_signal_state_count(): number;
  _us_sumo_time(): number;
  _us_sumo_last_error(): number;
  _us_sumo_close(): void;
  UTF8ToString(pointer: number): string;
  stringToUTF8(value: string, pointer: number, maxBytes: number): void;
  lengthBytesUTF8(value: string): number;
}

/** One SUMO-driven vehicle as the bridge packs it (network frame, float32 fields widened). */
export interface SumoPackedVehicle {
  readonly idHash: number;
  readonly x: number;
  readonly y: number;
  /** SUMO navigation degrees: 0 = network +y, clockwise. */
  readonly headingDegrees: number;
  readonly speedMps: number;
  readonly accelerationMps2: number;
  readonly lanePositionM: number;
  readonly signals: number;
}

export interface SumoPackedSignalLink {
  readonly controllerHash: number;
  readonly linkIndex: number;
  /** One SUMO link-state character (`G`, `g`, `y`, `r`, `s`, `o`, `O`, …). */
  readonly state: string;
}

export type SumoExternalKind = 'vehicle' | 'pedestrian' | 'bicycle' | 'obstacle';

/** An externally owned occupancy proxy, already in the network frame. */
export interface SumoExternalProxy {
  readonly id: string;
  readonly kind: SumoExternalKind;
  readonly routeId: string;
  readonly x: number;
  readonly y: number;
  readonly headingDegrees: number;
  readonly speedMps: number;
  readonly lengthM: number;
  readonly widthM: number;
}

export class SumoRuntimeError extends Error {
  override readonly name = 'SumoRuntimeError';
}

/** One libsumo world inside one module instance. */
export class SumoWasmSession {
  private started = false;

  constructor(private readonly sumo: SumoWasmModule) {}

  start(network: Uint8Array, routes: Uint8Array, stepSeconds: number, seed: number): void {
    const net = this.copy(network);
    const rou = this.copy(routes);
    try {
      this.ok(this.sumo._us_sumo_start(net, network.byteLength, rou, routes.byteLength, stepSeconds, seed));
    } finally {
      this.sumo._free(net);
      this.sumo._free(rou);
    }
    this.started = true;
  }

  step(deltaSeconds: number): void {
    this.ok(this.sumo._us_sumo_step(deltaSeconds));
  }

  upsert(proxy: SumoExternalProxy): void {
    this.withString(proxy.id, (id) => this.withString(proxy.routeId, (route) => this.ok(this.sumo._us_sumo_upsert_external(
      id,
      proxy.kind === 'pedestrian' ? 1 : proxy.kind === 'bicycle' ? 2 : proxy.kind === 'obstacle' ? 3 : 0,
      route,
      proxy.x,
      proxy.y,
      proxy.headingDegrees,
      proxy.speedMps,
      proxy.lengthM,
      proxy.widthM,
    ))));
  }

  remove(id: string): void {
    this.withString(id, (pointer) => this.ok(this.sumo._us_sumo_remove(pointer)));
  }

  /** Bridge clock (seconds accumulated by `step`). */
  time(): number {
    return this.sumo._us_sumo_time();
  }

  vehicles(): SumoPackedVehicle[] {
    const count = this.sumo._us_sumo_state_count();
    const view = new DataView(this.sumo.HEAPU8.buffer, this.sumo._us_sumo_state_pointer(), count * 32);
    const vehicles: SumoPackedVehicle[] = [];
    for (let offset = 0; offset < count * 32; offset += 32) {
      vehicles.push({
        idHash: view.getUint32(offset, true),
        x: view.getFloat32(offset + 4, true),
        y: view.getFloat32(offset + 8, true),
        headingDegrees: view.getFloat32(offset + 12, true),
        speedMps: view.getFloat32(offset + 16, true),
        accelerationMps2: view.getFloat32(offset + 20, true),
        lanePositionM: view.getFloat32(offset + 24, true),
        signals: view.getUint32(offset + 28, true),
      });
    }
    return vehicles;
  }

  signalLinks(): SumoPackedSignalLink[] {
    const count = this.sumo._us_sumo_signal_state_count();
    const view = new DataView(this.sumo.HEAPU8.buffer, this.sumo._us_sumo_signal_state_pointer(), count * 8);
    const links: SumoPackedSignalLink[] = [];
    for (let offset = 0; offset < count * 8; offset += 8) {
      links.push({
        controllerHash: view.getUint32(offset, true),
        linkIndex: view.getUint16(offset + 4, true),
        state: String.fromCharCode(view.getUint8(offset + 6)),
      });
    }
    return links;
  }

  close(): void {
    if (this.started) this.sumo._us_sumo_close();
    this.started = false;
  }

  private copy(bytes: Uint8Array): number {
    const pointer = this.sumo._malloc(Math.max(1, bytes.byteLength));
    this.sumo.HEAPU8.set(bytes, pointer);
    return pointer;
  }

  private withString<T>(value: string, callback: (pointer: number) => T): T {
    const size = this.sumo.lengthBytesUTF8(value) + 1;
    const pointer = this.sumo._malloc(size);
    try {
      this.sumo.stringToUTF8(value, pointer, size);
      return callback(pointer);
    } finally {
      this.sumo._free(pointer);
    }
  }

  private ok(code: number): void {
    if (code === 0) return;
    throw new SumoRuntimeError(this.sumo.UTF8ToString(this.sumo._us_sumo_last_error()) || `SUMO failed (${code})`);
  }
}

/** FNV-1a over UTF-16 code units, as the bridge hashes (ASCII) SUMO ids. */
export function sumoIdHash(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A pinned runtime: provenance plus a factory that returns a *fresh* module
 * instance. The worker never reuses an instance between runs, so no libsumo
 * static state (id counters, parser caches) can leak from one job to the next.
 */
export interface SumoRuntime {
  /** `<sumoVersion>-<commit[0:8]>`, e.g. `1.27.1-7717f237`. */
  readonly version: string;
  readonly sumoVersion: string;
  readonly sumoCommit: string;
  /** sha256 of the exact `sumo.wasm` bytes. */
  readonly wasmSha256: string;
  createModule(onStderr: (line: string) => void): Promise<SumoWasmModule>;
}
