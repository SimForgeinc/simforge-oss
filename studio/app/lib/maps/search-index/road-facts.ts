import {
  parseGeometrySegments,
  type RoadSegmentEntity,
  type XodrJunctionMatchInfo,
} from "@simforge-oss/studio-shared";
import {
  CURVATURE_SEGMENT_MIN_LENGTH_M,
  classifyCurvature,
  crestPresentFromPct,
  gradeClassFromPct,
  speedClassFromMph,
  widthClassFromMeters,
  type CurvatureClass,
  type WidthClass,
} from "@/app/lib/maps/search/classification-thresholds";

export interface XodrVectorIdMaps {
  laneUuidToRoadId: Map<string, string>;
  junctionUuidToXodrId: Map<string, string>;
}

export function parseVectorIdMaps(xodrText: string): XodrVectorIdMaps {
  const laneUuidToRoadId = new Map<string, string>();
  const junctionUuidToXodrId = new Map<string, string>();
  if (!xodrText.trim()) return { laneUuidToRoadId, junctionUuidToXodrId };

  const roadRe = /<road\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/road>/g;
  let m: RegExpExecArray | null;
  while ((m = roadRe.exec(xodrText)) !== null) {
    const roadId = m[1] ?? "";
    const body = m[2] ?? "";
    const vectorLaneRe = /<vectorLane\b[^>]*\blaneId="(\{[^"}]+\})"/g;
    let v: RegExpExecArray | null;
    while ((v = vectorLaneRe.exec(body)) !== null) {
      laneUuidToRoadId.set(v[1]!, roadId);
    }
  }

  const juncRe = /<junction\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/junction>/g;
  while ((m = juncRe.exec(xodrText)) !== null) {
    const xodrJunctionId = m[1] ?? "";
    const body = m[2] ?? "";
    const v = /<vectorJunction\b[^>]*\bjunctionId="(\{[^"}]+\})"/.exec(body);
    if (v) junctionUuidToXodrId.set(v[1]!, xodrJunctionId);
  }

  return { laneUuidToRoadId, junctionUuidToXodrId };
}

export function junctionControlType(
  info: XodrJunctionMatchInfo,
): "uncontrolled" | "stop" | "all_way_stop" | "traffic_light" {
  if (info.hasTrafficLight) return "traffic_light";
  if (info.allWayStop) return "all_way_stop";
  if (info.hasStopSign) return "stop";
  return "uncontrolled";
}

export interface PerRoadFacts {
  speed_class?: "low" | "medium" | "high";
  grade_class?: "flat" | "moderate" | "steep";
  crest_present?: boolean;
  bike_lane_present?: boolean;
  parking_present?: boolean;
  parking_both_sides?: boolean;
  sidewalk_present?: boolean;
  curvature_class?: "straight" | "curved" | "sharp";
  min_radius_m?: number;
  width_class?: WidthClass;
  speed_limit_mph?: number;
  grade_pct?: number;
  is_junction_internal?: boolean;
}

export function roadCurvatureFacts(
  roadBody: string,
): Pick<PerRoadFacts, "curvature_class" | "min_radius_m"> {
  const segments = parseGeometrySegments(roadBody);
  let maxAbsCurvature = 0;
  for (const seg of segments) {
    if (seg.length < CURVATURE_SEGMENT_MIN_LENGTH_M) continue;
    let k = 0;
    if (seg.type === "arc") {
      k = Math.abs(seg.curvature ?? 0);
    } else if (seg.type === "spiral") {
      k = Math.max(Math.abs(seg.curvStart ?? 0), Math.abs(seg.curvEnd ?? 0));
    }
    if (k > maxAbsCurvature) maxAbsCurvature = k;
  }

  if (segments.length === 0) return {};

  const curvatureClass: CurvatureClass = classifyCurvature(maxAbsCurvature);
  const minRadiusM = maxAbsCurvature > 0 ? Math.round(1 / maxAbsCurvature) : undefined;

  return {
    curvature_class: curvatureClass,
    ...(minRadiusM != null ? { min_radius_m: minRadiusM } : {}),
  };
}

export function roadWidthClass(roadBody: string): WidthClass | undefined {
  const sectionRe = /<laneSection\b[\s\S]*?<\/laneSection>/gi;
  const sectionWidths: number[] = [];
  const sections = roadBody.match(sectionRe);
  if (!sections || sections.length === 0) return undefined;

  for (const section of sections) {
    const laneRe = /<lane\b([^>]*)>([\s\S]*?)<\/lane>/gi;
    let sectionWidth = 0;
    let foundDriving = false;
    let lm: RegExpExecArray | null;
    while ((lm = laneRe.exec(section)) !== null) {
      const attrs = lm[1] ?? "";
      const body = lm[2] ?? "";
      if (!/\btype\s*=\s*"driving"/i.test(attrs)) continue;
      const widthMatch = body.match(/<width\b[^>]*\ba\s*=\s*"([\-\d.eE+]+)"/i);
      if (!widthMatch) continue;
      const a = parseFloat(widthMatch[1]!);
      if (Number.isFinite(a) && a > 0) {
        sectionWidth += a;
        foundDriving = true;
      }
    }
    if (foundDriving && sectionWidth > 0) sectionWidths.push(sectionWidth);
  }

  if (sectionWidths.length === 0) return undefined;
  sectionWidths.sort((a, b) => a - b);
  const mid = Math.floor(sectionWidths.length / 2);
  const median =
    sectionWidths.length % 2 === 0
      ? (sectionWidths[mid - 1]! + sectionWidths[mid]!) / 2
      : sectionWidths[mid]!;
  return widthClassFromMeters(median);
}

function roadParkingBothSidesFact(roadBody: string): boolean | undefined {
  const sectionRe = /<laneSection\b[\s\S]*?<\/laneSection>/gi;
  const sections = roadBody.match(sectionRe);
  if (!sections || sections.length === 0) return undefined;

  const sideHasParking = (sectionBody: string, side: "left" | "right"): boolean => {
    const sideRe = new RegExp(`<${side}\\b[\\s\\S]*?<\\/${side}>`, "i");
    const match = sectionBody.match(sideRe);
    if (!match) return false;
    return /<lane\b[^>]*\btype\s*=\s*"parking"/i.test(match[0]);
  };

  let bothSidesCount = 0;
  for (const section of sections) {
    if (sideHasParking(section, "left") && sideHasParking(section, "right")) {
      bothSidesCount += 1;
    }
  }
  return bothSidesCount * 2 >= sections.length && bothSidesCount > 0;
}

export function collectRoadBodies(xodrText: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const re = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xodrText)) !== null) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    if (!idMatch) continue;
    bodies.set(idMatch[1]!, body);
  }
  return bodies;
}

export function buildPerRoadFacts(
  entities: readonly RoadSegmentEntity[],
  roadBodies: Map<string, string>,
): Map<string, PerRoadFacts> {
  const byRoadId = new Map<string, PerRoadFacts>();

  for (const e of entities) {
    const speedClass = speedClassFromMph(e.speedLimitMph);
    const gradeClass = gradeClassFromPct(e.gradePct);
    const crestPresent = crestPresentFromPct(e.gradePct);
    const body = roadBodies.get(e.roadId);
    const curvature = body ? roadCurvatureFacts(body) : {};
    const widthClass = body ? roadWidthClass(body) : undefined;
    const parkingBothSides =
      body && e.hasParkingLane ? roadParkingBothSidesFact(body) : undefined;
    byRoadId.set(e.roadId, {
      ...(speedClass ? { speed_class: speedClass } : {}),
      ...(gradeClass ? { grade_class: gradeClass } : {}),
      ...(crestPresent ? { crest_present: true } : {}),
      bike_lane_present: e.hasBikeLane,
      parking_present: e.hasParkingLane,
      ...(parkingBothSides === true ? { parking_both_sides: true } : {}),
      sidewalk_present: e.hasSidewalk,
      ...curvature,
      ...(widthClass ? { width_class: widthClass } : {}),
      ...(e.speedLimitMph != null ? { speed_limit_mph: e.speedLimitMph } : {}),
      ...(e.gradePct != null ? { grade_pct: e.gradePct } : {}),
      ...(e.isJunctionInternal ? { is_junction_internal: true } : {}),
    });
  }
  return byRoadId;
}
