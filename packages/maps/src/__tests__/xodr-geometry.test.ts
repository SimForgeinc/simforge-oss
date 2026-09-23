import { describe, expect, it } from 'vitest';

import { xodrGeometryProjection, xodrGeometrySha256 } from '../node.js';

const base = (elevation: string, height: string, geometryHdg = '0') => `<?xml version="1.0"?>
<OpenDRIVE>
    <header revMajor="1" revMinor="4"/>
    <road name="r" length="10" id="1" junction="-1">
        <planView>
            <geometry s="0" x="0" y="0" hdg="${geometryHdg}" length="10"><line/></geometry>
        </planView>
        <elevationProfile>
${elevation}
        </elevationProfile>
        <lateralProfile>
            <superelevation s="0" a="0" b="0" c="0" d="0"/>
        </lateralProfile>
        <lanes>
            <laneSection s="0">
                <right>
                    <lane id="-1" type="driving" level="false">
                        <width sOffset="0" a="3.5" b="0" c="0" d="0"/>
${height}                        <userData/>
                    </lane>
                </right>
            </laneSection>
        </lanes>
    </road>
</OpenDRIVE>
`;

describe('xodrGeometrySha256', () => {
  const a = base('            <elevation s="0" a="1" b="0" c="0" d="0"/>', '                        <height sOffset="0" inner="0.15" outer="0.15"/>\n');
  it('ignores elevation, lateral profile and laneHeight', () => {
    const b = base('            <elevation s="0" a="2" b="0.01" c="0" d="0"/>\n            <elevation s="5" a="2.05" b="0.01" c="0" d="0"/>', '');
    expect(xodrGeometrySha256(b)).toBe(xodrGeometrySha256(a));
    expect(xodrGeometryProjection(a)).not.toContain('elevation');
    expect(xodrGeometryProjection(a)).not.toContain('<height');
    expect(xodrGeometryProjection(a)).toContain('<width sOffset="0" a="3.5"');
  });
  it('changes with any horizontal geometry', () => {
    expect(xodrGeometrySha256(base('            <elevation s="0" a="1" b="0" c="0" d="0"/>', '', '0.1'))).not.toBe(xodrGeometrySha256(a));
    expect(xodrGeometrySha256(a.replace('a="3.5"', 'a="3.6"'))).not.toBe(xodrGeometrySha256(a));
  });
  it('is a lowercase 64-hex digest', () => {
    expect(xodrGeometrySha256(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});
