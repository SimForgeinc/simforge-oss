/**
 * A document's versions changed (saved, kept, re-simulated, re-pointed): every open Versions view
 * of it reloads. Module-level so the banner and the panel stay in step without a shared parent.
 */
type Listener = (documentId: string) => void;
const listeners = new Set<Listener>();

export function onVersionsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function versionsChanged(documentId: string): void {
  for (const listener of listeners) listener(documentId);
}
