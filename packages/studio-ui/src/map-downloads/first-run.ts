/**
 * Whether a person has been shown the map download panel on their first
 * sign-in.
 *
 * Kept per browser, keyed by the account's user id: there is no server-side
 * user-preferences store to put it in, and the panel is about THIS browser's
 * map cache anyway — a second browser starts with an empty cache, so offering
 * it there once is the right behaviour. The marker is written the moment the
 * panel is shown, so a reload never shows it again whatever the person chose.
 */

const PREFIX = "simforge.first-run.map-downloads.v1:";
/** Seen in this page even when storage refused the write, so it never loops. */
const seenThisPage = new Set<string>();

type ReadStorage = Pick<Storage, "getItem"> | null | undefined;
type WriteStorage = Pick<Storage, "setItem"> | null | undefined;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function mapDownloadsFirstRunKey(userId: string): string {
  return `${PREFIX}${userId}`;
}

/**
 * True when this user has never been shown the panel in this browser.
 * Unreadable storage answers false: a first-run prompt that could never be
 * dismissed would reappear on every page.
 */
export function isMapDownloadsFirstRunPending(userId: string | null | undefined, storage: ReadStorage = browserStorage()): boolean {
  if (!userId || !storage || seenThisPage.has(userId)) return false;
  try {
    return storage.getItem(mapDownloadsFirstRunKey(userId)) === null;
  } catch {
    return false;
  }
}

export function markMapDownloadsFirstRunSeen(userId: string | null | undefined, storage: WriteStorage = browserStorage()): void {
  if (!userId) return;
  seenThisPage.add(userId);
  if (!storage) return;
  try {
    storage.setItem(mapDownloadsFirstRunKey(userId), new Date().toISOString());
  } catch {
    // Read-only storage: `isMapDownloadsFirstRunPending` already answers false.
  }
}

/** Test seam. */
export function resetMapDownloadsFirstRunForTests(): void {
  seenThisPage.clear();
}
