/**
 * Discard an unread response body.
 *
 * `response.body.cancel()` is the obvious way to do this, and on the Node build
 * inside the packaged desktop app (v24.20.0) it returns a promise that never
 * settles for an unread `fetch` body. Awaiting it deadlocks the caller: the
 * map library page renders its loading state forever on any machine without a
 * SimCloud session, because the public catalog answers 401 and the error path
 * awaits exactly that cancel. Reading the body settles.
 *
 * Error bodies here are small (a JSON error object), so reading is cheap, and
 * it drains the socket for reuse rather than leaving a half-read response.
 */
export async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) return;
  try {
    await response.text();
  } catch {
    // A failed drain is not worth reporting: the caller is already handling an
    // error, and an undrained socket is closed rather than reused.
  }
}
