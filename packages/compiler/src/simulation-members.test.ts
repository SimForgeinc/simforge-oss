import { describe, expect, it } from 'vitest';

import { isSimulationMapMember, SIMULATION_MAP_MEMBERS, simulationMemberSources, simulationMemberSqlPredicate } from './simulation-members.js';

describe('simulation map members', () => {
  it('is the one list of what a simulation reads, the ground included', () => {
    for (const member of ['map.xodr', 'topology-index.json.gz', 'signals.geojson.gz', 'derived/topology-derived.json.gz', 'derived/locations.json.gz', 'derived/ground/ground-mesh.bin', '3d/variants/static-colliders-v1.json']) {
      expect(isSimulationMapMember(member), member).toBe(true);
    }
    // Derived members that do not move a simulation never change the pin.
    for (const member of ['derived/sumo/map.net.xml', 'derived/ambient/turn-verdicts.json.gz', 'derived/ground/ground-report.json', '3d/manifest.json', 'lane-polygons.geojson.gz']) {
      expect(isSimulationMapMember(member), member).toBe(false);
    }
  });

  it('generates the pin predicate from the list', () => {
    const sql = simulationMemberSqlPredicate('m.relative_path');
    for (const member of SIMULATION_MAP_MEMBERS.exact) expect(sql).toContain(`'${member}'`);
    expect(sql).toContain("m.relative_path LIKE '3d/variants/static-colliders%'");
  });

  it('requests the ground member only for versions that carry it', () => {
    expect(simulationMemberSources('/r', { ground: false })).not.toHaveProperty('ground');
    expect(simulationMemberSources('/r', { ground: true }).ground).toBe('/r/derived/ground/ground-mesh.bin');
  });
});
