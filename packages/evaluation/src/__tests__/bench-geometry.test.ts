import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildRoadBoundaryOutline } from '@simforge-oss/maps/topology';
import { loadBenchDrivableArea } from '../bench-geometry.js';
import { classifyPoint, offRoadMetricVersion } from '../replay-context/drivable.js';

const xodr = `<OpenDRIVE>
<header revMajor="1" revMinor="4"/>
<road id="1" length="100" junction="-1">
<planView><geometry s="0" x="0" y="0" hdg="0" length="100"><line/></geometry></planView>
<lanes><laneSection s="0">
<left>
<lane id="1" type="driving"><width sOffset="0" a="3" b="0" c="0" d="0"/></lane>
<lane id="2" type="shoulder"><width sOffset="0" a="2" b="0" c="0" d="0"/></lane>
<lane id="3" type="sidewalk"><width sOffset="0" a="2" b="0" c="0" d="0"/></lane>
</left>
<center><lane id="0" type="none"/></center>
<right>
<lane id="-1" type="driving"><width sOffset="0" a="3" b="0" c="0" d="0"/></lane>
<lane id="-2" type="restricted"><width sOffset="0" a="2" b="0" c="0" d="0"/></lane>
</right>
</laneSection></lanes>
</road>
<road id="2" length="20" junction="-1">
<planView><geometry s="0" x="102" y="1" hdg="0" length="20"><line/></geometry></planView>
<lanes><laneSection s="0">
<left><lane id="1" type="driving"><width sOffset="0" a="1" b="0" c="0" d="0"/></lane></left>
<center><lane id="0" type="none"/></center>
<right><lane id="-1" type="driving"><width sOffset="0" a="1" b="0" c="0" d="0"/></lane></right>
</laneSection></lanes>
</road></OpenDRIVE>`;

describe('source road-boundary bench instrument', () => {
  it('dissolves lane seams, includes source shoulders, excludes sidewalks and refuses unknown map ends', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'simforge-road-outline-'));
    try {
      const outline = buildRoadBoundaryOutline(xodr, createHash('sha256').update(xodr).digest('hex'));
      await writeFile(path.join(directory, 'map.xodr'), xodr);
      await writeFile(path.join(directory, 'road-boundary.json.gz'), gzipSync(JSON.stringify(outline)));
      const area = (await loadBenchDrivableArea(directory))!;
      expect(offRoadMetricVersion(area)).toBe('simforge.offroad/v3');
      expect(classifyPoint(area, 50, 0).verdict).toBe('drivable');
      expect(classifyPoint(area, 50, 4).verdict).toBe('drivable');
      expect(classifyPoint(area, 50, 6).verdict).toBe('off-road');
      expect(classifyPoint(area, 50, -4).verdict).toBe('off-road');
      // The second road's open terminus is closer than this road's kerb:
      // known source surface wins, without extrapolating into the gap.
      expect(classifyPoint(area, 99.5, 1).verdict).toBe('drivable');
      expect(classifyPoint(area, 101, 1).verdict).toBe('unavailable');
      await writeFile(path.join(directory, 'map.xodr'), `${xodr}\n`);
      await expect(loadBenchDrivableArea(directory)).rejects.toThrow('source identity mismatch');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
