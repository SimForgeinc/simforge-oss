/**
 * The shared evaluation product surface: clip upload, model choice, cloud
 * submission, job history and results, used unchanged by the SimForge desktop
 * app and the SimCloud web portal.
 *
 * BUNDLE BOUNDARY — this barrel is browser-safe and map/3D-free. Nothing here,
 * transitively, may import the package root barrel, `three`, the editor, the
 * engine, the viewer, the playback worker or any Node-only module: the web
 * portal imports this subpath precisely so that a portal page cannot pull a map
 * or a 3D scene into its bundle. The desktop model store lives on the separate
 * `./evaluation/model-store` subpath because the portal has no local store and
 * must not call its routes.
 */

export * from "./contracts";
export * from "./gateway";
export * from "./input-kinds";
export * from "./model-catalog";
export * from "./params";
export * from "./presentation";
export * from "./projection";
export * from "./sha256";
export * from "./upload";
export * from "./useJobResult";

export { DesktopRequiredNotice } from "./components/DesktopRequiredNotice";
export { EvaluationLauncher, type LocalRunLauncher } from "./components/EvaluationLauncher";
export { EvaluationWorkspace } from "./components/EvaluationWorkspace";
export { FrameOverlay, type FrameSource } from "./components/FrameOverlay";
export { InputPicker, type PreparedInput } from "./components/InputPicker";
export { JobDetail } from "./components/JobDetail";
export { JobHistory, JobStatusBadge } from "./components/JobHistory";
export { ModelPicker, type ModelSelection } from "./components/ModelPicker";
export { RefusalNotice } from "./components/RefusalNotice";
export { TrajectoryPlot } from "./components/TrajectoryPlot";
