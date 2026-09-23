import { describe, expect, it } from 'vitest';

import { parseLidarPly, parseRadarCsv } from './sensor-video.js';

const PLY_HEADER = [
  'ply', 'format ascii 1.0', 'element vertex 2',
  'property float x', 'property float y', 'property float z', 'property float intensity', 'property uint instance_id',
  'end_header',
].join('\n');

describe('native sensor payload parsers', () => {
  it('parse the service layouts', () => {
    const scan = parseLidarPly(Buffer.from(`${PLY_HEADER}\n1 2 3 0.5 7\n-4 0.25 6 1 0\n`));
    expect(scan.count).toBe(2);
    expect([...scan.xyz]).toEqual([1, 2, 3, -4, 0.25, 6]);
    expect([...scan.intensity]).toEqual([0.5, 1]);
    const radar = parseRadarCsv(Buffer.from('depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,-0.02,3\n'));
    expect(radar.count).toBe(1);
    expect(radar.depthM[0]).toBe(12.5);
    expect(parseRadarCsv(Buffer.from('depth_m,azimuth_rad,altitude_rad,velocity_mps\n')).count).toBe(0);
  });

  it('refuse malformed lidar frames instead of plotting NaN points or dropping rows', () => {
    for (const body of [
      `${PLY_HEADER}\n1 2 NaN 0.5 7\n-4 0.25 6 1 0\n`, // non-finite coordinate
      `${PLY_HEADER}\n1 2 3 0.5\n-4 0.25 6 1 0\n`, // missing field
      `${PLY_HEADER}\n1 2 3 0.5 7\n`, // fewer rows than declared
      `${PLY_HEADER}\n1 2 3 0.5 7\n-4 0.25 6 1 0\n9 9 9 9 9\n`, // more rows than declared
      `${PLY_HEADER.replace('property float y\nproperty float z', 'property float z\nproperty float y')}\n1 2 3 0.5 7\n-4 0.25 6 1 0\n`,
      `${PLY_HEADER}\n1  3 0.5 7\n-4 0.25 6 1 0\n`, // empty field
    ]) {
      expect(() => parseLidarPly(Buffer.from(body), 'lidar top'), body).toThrow(expect.objectContaining({ code: 'native_sensor_payload_invalid' }));
    }
  });

  it('refuse malformed radar frames', () => {
    for (const body of [
      'depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,-0.02\n',
      'depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,,3\n',
      'depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,inf,0,3\n',
      'depth_m,azimuth,altitude,velocity\n12.5,0.1,0,3\n',
      'depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,0,3',
    ]) {
      expect(() => parseRadarCsv(Buffer.from(body), 'radar front'), body).toThrow(expect.objectContaining({ code: 'native_sensor_payload_invalid' }));
    }
  });
});
