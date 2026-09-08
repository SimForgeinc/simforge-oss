"use client";

/**
 * The handoff between the scenario editor and the Drive page for one Manual
 * drive take.
 *
 * The editor stays open in its own tab so the finished take lands as one
 * undoable document transaction; the recorder runs in a second tab (or, when
 * pop-ups are blocked, in the same tab with a return link). The two share a
 * same-origin `localStorage` mailbox keyed by take id:
 *
 * - `request`: exactly what to record — the in-memory document at open time,
 *   the actor, the interaction, and an opaque guard the editor checks on save.
 * - `result`: the recorded take, or an explicit cancellation.
 * - `pending.<documentId>`: the take the document is waiting on, so an editor
 *   that reloaded (same-tab fallback) can still find and review its result.
 *
 * Nothing here persists scenario content. The recorder never writes the
 * document; the editor never trusts a result whose guard it did not issue.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  ManualDriveRecording,
  ScenarioTemplateV2,
} from "@simforge-oss/scenario";

/** Query parameter the Drive page reads to enter take mode. */
export const MANUAL_DRIVE_TAKE_QUERY = "manualDriveTake";

/** The Drive page route. Studio hosts mount it here; the editor deep-links to it. */
export const MANUAL_DRIVE_PAGE_PATH = "/dashboard/drive";

const STORAGE_PREFIX = "simforge.manualDrive.take.";
/** Requests older than this are abandoned tabs, never live recorders. */
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface ManualDriveTakeRequest {
  readonly takeId: string;
  readonly datasetId: string;
  readonly documentId: string;
  readonly mapVersionId: string;
  readonly interactionId: string;
  readonly actorRoleId: string;
  /** The clip the take must cover, seconds. Never a default; read from the document. */
  readonly clipSeconds: number;
  /** Opaque editor guard. Echo it back unchanged with the recording. */
  readonly revision: string;
  /** The exact in-memory document at open time. Recorders load this, not a server copy. */
  readonly content: ScenarioTemplateV2;
  /** Where a same-tab recorder returns to when it finishes. */
  readonly returnHref: string;
  readonly openedAt: number;
}

export type ManualDriveTakeResult =
  | { readonly kind: "saved"; readonly recording: ManualDriveRecording; readonly revision: string; readonly finishedAt: number }
  | { readonly kind: "cancelled"; readonly finishedAt: number };

/** What the Drive page receives: the request plus the two ways a take ends. */
export interface ManualDriveTakeSession extends ManualDriveTakeRequest {
  /** Deliver the finished take. Resolves once the editor can see it; the tab then closes or returns. */
  onSave(recording: ManualDriveRecording, revision: string): Promise<void>;
  /** Abandon the take. Nothing is written to the document. */
  onCancel(): void;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Both the request and result carry the take id, so a key is cheap to derive. */
function requestKey(takeId: string): string {
  return `${STORAGE_PREFIX}${takeId}.request`;
}

function resultKey(takeId: string): string {
  return `${STORAGE_PREFIX}${takeId}.result`;
}

function pendingKey(documentId: string): string {
  return `${STORAGE_PREFIX}pending.${documentId}`;
}

/** Drop every abandoned request and its result so the mailbox cannot grow without bound. */
function sweepStaleTakes(store: Storage, now: number): void {
  const stale: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (!key || !key.startsWith(STORAGE_PREFIX) || !key.endsWith(".request")) continue;
    const request = readJson<ManualDriveTakeRequest>(key);
    if (!request || now - request.openedAt > REQUEST_TTL_MS) stale.push(key.slice(STORAGE_PREFIX.length, -".request".length));
  }
  for (const takeId of stale) {
    store.removeItem(requestKey(takeId));
    store.removeItem(resultKey(takeId));
  }
}

export function manualDriveTakeHref(takeId: string): string {
  return `${MANUAL_DRIVE_PAGE_PATH}?${MANUAL_DRIVE_TAKE_QUERY}=${encodeURIComponent(takeId)}`;
}

/**
 * Publish a take request and remember it as the document's pending take.
 * Returns the href to open; the caller decides between a new tab and same-tab.
 */
export function openManualDriveTake(
  request: Omit<ManualDriveTakeRequest, "takeId" | "openedAt">,
): { readonly takeId: string; readonly href: string } | { readonly error: string } {
  const store = storage();
  if (!store) return { error: "This browser does not allow the editor to hand a take to the recorder (localStorage is unavailable)." };
  const now = Date.now();
  sweepStaleTakes(store, now);
  const takeId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const previous = store.getItem(pendingKey(request.documentId));
  if (previous) {
    store.removeItem(requestKey(previous));
    store.removeItem(resultKey(previous));
  }
  try {
    store.setItem(requestKey(takeId), JSON.stringify({ ...request, takeId, openedAt: now } satisfies ManualDriveTakeRequest));
    store.setItem(pendingKey(request.documentId), takeId);
  } catch (reason) {
    store.removeItem(requestKey(takeId));
    return { error: `The take request could not be handed to the recorder: ${reason instanceof Error ? reason.message : String(reason)}` };
  }
  return { takeId, href: manualDriveTakeHref(takeId) };
}

export function readManualDriveTakeRequest(takeId: string): ManualDriveTakeRequest | null {
  const request = readJson<ManualDriveTakeRequest>(requestKey(takeId));
  return request && request.takeId === takeId ? request : null;
}

export function readManualDriveTakeResult(takeId: string): ManualDriveTakeResult | null {
  return readJson<ManualDriveTakeResult>(resultKey(takeId));
}

export function writeManualDriveTakeResult(takeId: string, result: ManualDriveTakeResult): void {
  const store = storage();
  if (!store) throw new Error("localStorage is unavailable; the take cannot be returned to the editor");
  store.setItem(resultKey(takeId), JSON.stringify(result));
}

/** The take a document is waiting on, if any. */
export function pendingManualDriveTakeId(documentId: string): string | null {
  return storage()?.getItem(pendingKey(documentId)) ?? null;
}

/** Forget a take entirely, whichever side finished it. */
export function clearManualDriveTake(takeId: string, documentId: string): void {
  const store = storage();
  if (!store) return;
  store.removeItem(requestKey(takeId));
  store.removeItem(resultKey(takeId));
  if (store.getItem(pendingKey(documentId)) === takeId) store.removeItem(pendingKey(documentId));
}

/**
 * Wake the listener when another tab writes this take's result. `storage`
 * events fire only across documents, which is exactly the two-tab case; the
 * same-tab fallback is covered by reading the result on mount.
 */
export function subscribeManualDriveTakeResult(
  takeId: string,
  listener: (result: ManualDriveTakeResult) => void,
): () => void {
  const key = resultKey(takeId);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key || event.newValue === null) return;
    const result = readManualDriveTakeResult(takeId);
    if (result) listener(result);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * Leave the recorder once a take has been delivered. A tab the editor opened
 * closes itself; a same-tab recorder returns to the editor, which reads the
 * result on mount.
 */
function leaveRecorder(request: ManualDriveTakeRequest): void {
  if (window.opener && !window.opener.closed) {
    window.close();
    // Browsers may refuse to close a tab the user has since navigated in; fall
    // through to the return link rather than stranding the recorder.
  }
  window.location.assign(request.returnHref);
}

/**
 * The Drive page's view of a take: `null` when the page was not opened for one
 * or the request has expired. Callbacks deliver exactly once; a second call
 * after the take ended is a no-op.
 */
export function useManualDriveTakeSession(takeId: string | null): ManualDriveTakeSession | null {
  const [request, setRequest] = useState<ManualDriveTakeRequest | null>(null);
  useEffect(() => {
    setRequest(takeId ? readManualDriveTakeRequest(takeId) : null);
  }, [takeId]);
  return useMemo(() => {
    if (!request) return null;
    let finished = false;
    return {
      ...request,
      async onSave(recording, revision) {
        if (finished) return;
        finished = true;
        writeManualDriveTakeResult(request.takeId, { kind: "saved", recording, revision, finishedAt: Date.now() });
        leaveRecorder(request);
      },
      onCancel() {
        if (finished) return;
        finished = true;
        writeManualDriveTakeResult(request.takeId, { kind: "cancelled", finishedAt: Date.now() });
        leaveRecorder(request);
      },
    };
  }, [request]);
}
