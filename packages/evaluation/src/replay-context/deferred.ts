/**
 * `Promise.withResolvers` for this package's compile target.
 *
 * Node 22 has the standard method, but the workspace compiles against the ES2022 lib, where
 * it is not declared. Rather than nesting executor callbacks at every call site — the thing
 * `withResolvers` exists to avoid — the executor form is written once here and the callers
 * stay linear.
 */

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
