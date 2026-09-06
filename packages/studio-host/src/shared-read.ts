/**
 * Request sharing for catalog-style reads (datasets, tags, maps).
 *
 * An in-flight request never expires: the finite TTL begins only after it
 * resolves, so a slow request cannot be replaced by a second request. Callers
 * still get their own abort semantics without cancelling the shared load.
 */
type SharedReadEntry = {
  readonly expiresAt: number;
  readonly promise: Promise<unknown>;
};

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export class SharedReads {
  private readonly entries = new Map<string, SharedReadEntry>();

  read<T>(key: string, ttlMs: number, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > Date.now()) {
      return withCallerAbort(current.promise as Promise<T>, signal);
    }
    const promise = load().then(
      (value) => {
        if (this.entries.get(key)?.promise === promise) {
          if (ttlMs > 0) this.entries.set(key, { expiresAt: Date.now() + ttlMs, promise });
          else this.entries.delete(key);
        }
        return value;
      },
      (error) => {
        if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, { expiresAt: Number.POSITIVE_INFINITY, promise });
    return withCallerAbort(promise, signal);
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Invalidate `key` once `mutation` settles successfully; the mutation's value passes through. */
  invalidateAfter<T>(key: string, mutation: Promise<T>): Promise<T> {
    return mutation.then((value) => {
      this.entries.delete(key);
      return value;
    });
  }

  clear(): void {
    this.entries.clear();
  }
}
