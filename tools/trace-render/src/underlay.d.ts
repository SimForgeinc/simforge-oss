export interface SurfacePatchRender {
  id: string;
  kind: 'ice' | 'packed_snow' | 'standing_water' | 'wet_leaves' | 'loose_gravel' | 'sand' | 'spilled_oil' | 'polished_asphalt' | 'grit_treated';
  region:
    | { kind: 'circle'; center: { x: number; z: number }; radiusM: number }
    | { kind: 'polygon'; points: Array<{ x: number; z: number }> }
    | { kind: 'laneWindow'; rsl: string; sMin: number; sMax: number };
}
export interface MarkingTreatmentRender {
  id: string;
  quality: 'crisp' | 'faded' | 'absent' | 'misaligned';
  region: { kind: 'laneWindow'; rsl: string; sMin: number; sMax: number };
}
export interface SurfaceRenderLane {
  rsl: string;
  widthM: number;
  pts: Array<{ x: number; y: number }>;
}
export const LANE_STYLES: Readonly<Record<string, { readonly fill: string }>>;
export const LANE_STYLE_FALLBACK: { readonly fill: string };
export const JUNCTION_SURFACE_FILL: string;
export const JUNCTION_SURFACE_WIDTH_FACTOR: number;
export const BOUNDARY_STROKE: string;
export const MISALIGNED_MARKING_OFFSET_M: number;
export const CROSSWALK_STRIPE_FILL: string;
export function underlayFromTopology(topology: any, locationsDoc?: any, signalsDoc?: unknown): any;
export function crosswalksFromLocations(locationsDoc: any): any[];
export function viewportBounds(view: any, marginM?: number): any;
export function offsetPolyline(points: any[], offsetM: number): any[];
export function underlaySvgLayers(
  underlay: any,
  view: any,
  project: (point: any) => any,
  surfacePatches?: SurfacePatchRender[],
  weatherPreset?: string | null,
  signalState?: {
    programs?: unknown[];
    ticks?: Record<string, { phase?: string[] }>;
    tickIndex: number;
    frameTime: number;
  } | null,
  markingTreatments?: MarkingTreatmentRender[],
): string[];
export function actorGlyph(id: string, kind: string | null, isStatic: boolean): { shape: 'box' | 'disc'; color: string };
export function stateValueAt(events: readonly { kind: string; actorId?: string; key?: string; t: number; value?: boolean | number | string }[] | undefined, actorId: string, key: string, t: number): boolean | number | string | undefined;
export function deterministicFlashPhase(t: number, hz: number): 0 | 1;
export function propSvgLayer(
  props: Array<{
    id: string;
    pose: { x: number; z: number; headingRad: number };
    dims: { l: number; w: number; h: number };
    scale?: number;
  }> | undefined,
  view: { camera: { x: number; y: number }; scale: number; width: number; height: number },
  project: (point: { x: number; y: number }) => { x: number; y: number },
): string[];
export function surfacePatchSvgLayer(
  patches: SurfacePatchRender[] | undefined,
  view: {
    camera: { x: number; y: number };
    scale: number;
    width: number;
    height: number;
    lanes?: SurfaceRenderLane[];
  },
  project: (point: { x: number; y: number }) => { x: number; y: number },
): string[];
export function signSvgLayer(
  signs: unknown[] | undefined,
  view: { camera: { x: number; y: number }; scale: number; width: number; height: number },
  project: (point: { x: number; y: number }) => { x: number; y: number },
): string[];
export function signalSvgLayer(
  signals: unknown[] | undefined,
  signalPrograms: unknown[] | undefined,
  signalTicks: Record<string, { phase?: string[] }> | undefined,
  tickIndex: number,
  frameTime: number,
  view: { camera: { x: number; y: number }; scale: number; width: number; height: number },
  project: (point: { x: number; y: number }) => { x: number; y: number },
  lanes?: unknown[],
): string[];
