/** Stop reading an error body after this much; enough for any JSON error. */
const DRAIN_BYTE_LIMIT = 64 * 1024;

/**
 * Discard an unread response body without waiting forever.
 *
 * `response.body.cancel()` is the obvious way to do this, and on the Node build
 * inside the packaged desktop app (v24.20.0) it returns a promise that never
 * settles for an unread `fetch` body. Awaiting it deadlocks the caller: the map
 * library page rendered its loading state forever on a machine whose upstream
 * answers 401, because that error path awaited exactly that cancel.
 *
 * Reading settles, so read - but bounded. Pulling with a reader and releasing
 * the lock after a cap keeps an unexpectedly large or slow error body from
 * being buffered whole, which `response.text()` would do. Whatever remains is
 * left to the connection teardown rather than accumulated here.
 *
 * This only discards the bytes. The caller still decides what the status means:
 * nothing here converts a 401 into a success.
 */
export async function discardResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body || response.bodyUsed) return;
  const reader = body.getReader();
  try {
    let seen = 0;
    while (seen < DRAIN_BYTE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value?.byteLength ?? 0;
    }
  } catch {
    // A failed drain is not worth reporting: the caller is already handling a
    // failure, and an undrained connection is closed rather than reused.
  } finally {
    reader.releaseLock();
  }
}
