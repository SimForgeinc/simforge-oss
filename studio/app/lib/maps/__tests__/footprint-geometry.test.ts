// Footprint projection: an OpenDRIVE header's extents rectangle to a WGS84
// ring the coverage map can draw.
//
//   pnpm --filter ./studio exec tsx --conditions=development --test \
//     app/lib/maps/__tests__/footprint-geometry.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapFootprintGeometry } from "../footprint-geometry";

/**
 * A transverse Mercator centred on Richmond Field Station's neighbourhood,
 * exactly as RoadRunner writes it, over a 1000 m × 1000 m network offset
 * 100 m north of the projection origin.
 */
const PROJ = "+proj=tmerc +lat_0=37.915 +lon_0=-122.335 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";

function header(attrs: string, geoReference = PROJ): string {
  return `<?xml version="1.0" standalone="yes"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="4" name="" version="1.00" date="2024-01-01T00:00:00" ${attrs} vendor="MathWorks">
${geoReference ? `    <geoReference><![CDATA[${geoReference}]]></geoReference>` : ""}
  </header>
</OpenDRIVE>`;
}

const RECTANGLE = 'north="6.0000000000000000e+02" south="-4.0000000000000000e+02" east="5.0000000000000000e+02" west="-5.0000000000000000e+02"';

describe("mapFootprintGeometry", () => {
  it("projects the extents rectangle corner by corner", () => {
    const { polygon, center } = mapFootprintGeometry(header(RECTANGLE));

    // Closed ring, south-west corner first, counter-clockwise.
    assert.equal(polygon.length, 5);
    assert.deepEqual(polygon[0], polygon[4]);
    const [sw, se, ne, nw] = polygon as [
      [number, number], [number, number], [number, number], [number, number],
    ];
    assert.ok(se[0] > sw[0] && ne[0] > nw[0], "east corners are east of west corners");
    assert.ok(ne[1] > se[1] && nw[1] > sw[1], "north corners are north of south corners");

    // The rectangle sits symmetrically on the central meridian, so its centre
    // lands exactly on `lon_0` and 100 m north of `lat_0` (~1 deg / 111 km).
    assert.equal(center[0], -122.335);
    assert.ok(Math.abs(center[1] - (37.915 + 100 / 110_996)) < 1e-5, `centre latitude ${center[1]}`);

    // 500 m east/west of the meridian at this latitude is ~0.005692 deg.
    const halfWidthDeg = 500 / (111_320 * Math.cos((37.915 * Math.PI) / 180));
    assert.ok(Math.abs(se[0] - (-122.335 + halfWidthDeg)) < 1e-4, `east edge ${se[0]}`);
    assert.ok(Math.abs(sw[0] - (-122.335 - halfWidthDeg)) < 1e-4, `west edge ${sw[0]}`);

    // Each corner is projected on its own: a metre of easting is more degrees
    // of longitude the further north it sits, so the north edge of a
    // metre-rectangle spans more longitude than its south edge. Projecting one
    // centre and offsetting a rectangle would lose exactly this.
    assert.ok(ne[0] - nw[0] > se[0] - sw[0], "north edge spans more longitude than the south edge");

    // Frozen projection output; a proj string, datum or axis-order regression
    // moves these.
    assert.deepEqual(polygon.map(([lon, lat]) => [Number(lon.toFixed(7)), Number(lat.toFixed(7))]), [
      [-122.3406858, 37.9113961],
      [-122.3293142, 37.9113961],
      [-122.3293135, 37.9204055],
      [-122.3406865, 37.9204055],
      [-122.3406858, 37.9113961],
    ]);
  });

  it("refuses a header without a georeference", () => {
    assert.throws(() => mapFootprintGeometry(header(RECTANGLE, "")), /geoReference/);
  });

  it("refuses a degenerate rectangle", () => {
    assert.throws(
      () => mapFootprintGeometry(header('north="0" south="0" east="0" west="0"')),
      /degenerate/,
    );
  });
});
