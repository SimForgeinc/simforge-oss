/**
 * The legacy `EditorWorkspaceStatus` publish shape, ported for v2.
 *
 * ~30 v1 panels publish through this signature. Keeping it means every one of
 * those ports is a data-layer rewire rather than also a status-API rewrite.
 * Statuses stack (severity, then recency) instead of competing for one slot.
 */
export {
  clampStatusProgress,
  userSafeErrorDetail as userSafeScenarioErrorDetail,
} from "./notification-model";

export type ScenarioWorkspaceStatusKind =
  | "loading"
  | "progress"
  | "warning"
  | "error";

export type ScenarioWorkspaceStatus = {
  kind: ScenarioWorkspaceStatusKind;
  label: string;
  detail?: string | null;
  progress?: number | null;
  actionLabel?: string | null;
  action?: (() => void) | null;
  /**
   * The editor is unusable until this resolves, so it renders in
   * `ScenarioBootGate` as an overlay rather than as a dismissable card.
   */
  blocking?: boolean;
};
