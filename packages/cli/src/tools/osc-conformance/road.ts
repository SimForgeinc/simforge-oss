/**
 * Synthetic OpenDRIVE roads for the OpenSCENARIO conformance corpus.
 *
 * Generated rather than vendored so the corpus has no third-party map bytes
 * and every coordinate a case asserts on is visible here:
 *
 * ```
 *   y = +1.75   lane  1   (travels -x, opposite direction)   600 m long
 *   y =  0      reference line, heading 0 (east)
 *   y = -1.75   lane -1   (travels +x)
 *   y = -5.25   lane -2
 *   y = -8.75   lane -3
 * ```
 *
 * The OSC world frame, the xodr-local frame and the engine's internal frame
 * coincide (x east, y north, z up, heading CCW from +x); the engine's
 * `SimScenarioInput` uses the y-up scene frame `(x, z = -y)`.
 */

export interface StraightRoadSpec {
  readonly lengthM: number;
  readonly laneWidthM: number;
  /** Driving lanes on the right of the reference line (ids -1..-n). */
  readonly rightLanes: number;
  /** Driving lanes on the left of the reference line (ids 1..n). */
  readonly leftLanes: number;
  readonly speedLimitKph: number;
}

export const DEFAULT_STRAIGHT_ROAD: StraightRoadSpec = Object.freeze({
  lengthM: 600,
  laneWidthM: 3.5,
  rightLanes: 3,
  leftLanes: 1,
  speedLimitKph: 130,
});

/** OSC/xodr-local `y` of the centre of lane `laneId` on the straight road. */
export function laneCenterY(laneId: number, spec: StraightRoadSpec = DEFAULT_STRAIGHT_ROAD): number {
  if (laneId === 0 || !Number.isInteger(laneId)) throw new Error(`invalid lane id ${laneId}`);
  const magnitude = (Math.abs(laneId) - 0.5) * spec.laneWidthM;
  return laneId > 0 ? magnitude : -magnitude;
}

export function straightRoadXodr(spec: StraightRoadSpec = DEFAULT_STRAIGHT_ROAD): string {
  const lane = (id: number) =>
    `<lane id="${id}" type="driving" level="false"><link/><width sOffset="0" a="${spec.laneWidthM}" b="0" c="0" d="0"/>` +
    `<roadMark sOffset="0" type="${Math.abs(id) === 1 ? 'solid' : 'broken'}" weight="standard" color="standard" width="0.12"/></lane>`;
  const left = Array.from({ length: spec.leftLanes }, (_, i) => lane(spec.leftLanes - i));
  const right = Array.from({ length: spec.rightLanes }, (_, i) => lane(-(i + 1)));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenDRIVE>',
    '<header revMajor="1" revMinor="6" name="simforge-osc-conformance-straight" version="1" north="0" south="0" east="0" west="0"/>',
    `<road name="straight" length="${spec.lengthM}" id="1" junction="-1">`,
    '<link/>',
    `<type s="0" type="motorway"><speed max="${spec.speedLimitKph}" unit="km/h"/></type>`,
    `<planView><geometry s="0" x="0" y="0" hdg="0" length="${spec.lengthM}"><line/></geometry></planView>`,
    '<elevationProfile><elevation s="0" a="0" b="0" c="0" d="0"/></elevationProfile>',
    '<lateralProfile/>',
    '<lanes><laneSection s="0">',
    left.length ? `<left>${left.join('')}</left>` : '',
    '<center><lane id="0" type="none" level="false"/></center>',
    right.length ? `<right>${right.join('')}</right>` : '',
    '</laneSection></lanes>',
    '</road>',
    '</OpenDRIVE>',
    '',
  ].filter((line) => line !== '').join('\n');
}
