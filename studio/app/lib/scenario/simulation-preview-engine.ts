/**
 * Which engine semantics produced a saved browser simulation.
 *
 * A saved simulation is current only for the engine semantics that would
 * produce it now. The draft version, content digest and map version were never
 * enough: after an engine change (the stop-spin fix is the case that forced
 * this), a render could freeze a trace the fixed engine no longer produces.
 *
 * The identity is read from the stored bytes themselves (the
 * `simforge.uniscenario-browser-preview/v3` document records the executing
 * engine, and its trace header repeats it), so nothing a client merely claims is
 * trusted, and no request contract changes.
 */

export type SimulationPreviewEngine = {
  /** Engine semantics version (`engineSemVer`; `engineVersion` in pre-0.8.0 documents). */
  readonly engineSemVer: string;
  readonly abiVersion: number;
};

type StoredPreviewShape = {
  engine?: { engineSemVer?: unknown; engineVersion?: unknown; abiVersion?: unknown };
  trace?: { header?: { engineVersion?: unknown } };
};

/**
 * The engine identity a stored preview document records, or `null` when it
 * does not record one consistently (its `engine` block and its trace header
 * disagree, or either is missing). A `null` preview is never current.
 */
export function simulationPreviewEngine(document: unknown): SimulationPreviewEngine | null {
  if (!document || typeof document !== "object") return null;
  const { engine, trace } = document as StoredPreviewShape;
  const semVer = engine?.engineSemVer ?? engine?.engineVersion;
  const abiVersion = engine?.abiVersion;
  if (typeof semVer !== "string" || semVer.length === 0) return null;
  if (typeof abiVersion !== "number" || !Number.isInteger(abiVersion)) return null;
  if (trace?.header?.engineVersion !== semVer) return null;
  return { engineSemVer: semVer, abiVersion };
}
