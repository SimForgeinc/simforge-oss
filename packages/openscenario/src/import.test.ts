import { describe, expect, it } from 'vitest';

import { analyzeOpenScenarioImport, OpenScenarioImportError, resolveOpenScenarioMap, translateOpenScenarioImport } from './import.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const valid = `<?xml version="1.0"?><OpenSCENARIO><FileHeader revMajor="1" revMinor="4" description="Imported cut-in"><Properties><Property name="uniscenarios.mapVersionId" value="map-a"/></Properties></FileHeader><RoadNetwork><LogicFile filepath="Town01.xodr"/></RoadNetwork><Entities><ScenarioObject name="Ego"><Vehicle name="sedan" vehicleCategory="car"/></ScenarioObject></Entities><Storyboard><Init><Actions><Private entityRef="Ego"><PrivateAction><TeleportAction><Position><WorldPosition x="1" y="2" z="3" h="0.5"/></Position></TeleportAction></PrivateAction><PrivateAction><LongitudinalAction><SpeedAction><SpeedActionTarget><AbsoluteTargetSpeed value="10"/></SpeedActionTarget></SpeedAction></LongitudinalAction></PrivateAction></Private></Actions></Init></Storyboard></OpenSCENARIO>`;
const MAP_A = { mapVersionId: 'map-a', sourceMapId: 'map-a', label: 'Town 01', xodrSha256: 'a'.repeat(64) };
const MAP_B = { mapVersionId: 'map-b', sourceMapId: 'map-b', label: 'Town 02', xodrSha256: 'b'.repeat(64) };

function withProperties(...properties: string[]) {
  return valid.replace(
    /<Properties>[\s\S]*?<\/Properties>/,
    `<Properties>${properties.map((property) => `<Property name="${property.split('=')[0]}" value="${property.slice(property.indexOf('=') + 1)}"/>`).join('')}</Properties>`,
  );
}

describe('OpenSCENARIO intake', () => {
  it('rejects DTD/entity input before parsing', () => {
    expect(() => analyzeOpenScenarioImport(bytes('<!DOCTYPE x [<!ENTITY e SYSTEM "https://example.com/x">]><OpenSCENARIO/>'))).toThrowError(OpenScenarioImportError);
  });

  it('reports capabilities, resolves embedded identity, and preserves source bytes', () => {
    const analysis = analyzeOpenScenarioImport(bytes(valid), 'cut-in.xosc');
    expect(analysis.actors[0]).toMatchObject({ id: 'Ego', x: 1, y: 3, z: -2, speedKph: 36 });
    expect(resolveOpenScenarioMap(analysis, [MAP_A])).toMatchObject({ status: 'resolved', source: 'embedded-identity', diagnostic: null });
    const document = translateOpenScenarioImport(analysis, { artifactId: 'usart-source', sha256: analysis.source.sha256, byteLength: analysis.source.byteLength, mediaType: 'application/xml' }, MAP_A, '2026-08-05T00:00:00.000Z');
    expect(document.roles[0]).toMatchObject({ kind: 'scene_absolute', initialSpeedKph: 36 });
    expect((document.extensions?.openScenarioImport as { source: { artifactId: string } }).source.artifactId).toBe('usart-source');
  });

  it('keeps immutable map-version identity separate from compiler-facing source-map identity', () => {
    const analysis = analyzeOpenScenarioImport(bytes(valid));
    const map = { ...MAP_A, sourceMapId: 'generic-town-source-20260805' };
    const document = translateOpenScenarioImport(
      analysis,
      { artifactId: 'usart-source', sha256: analysis.source.sha256, byteLength: analysis.source.byteLength, mediaType: 'application/xml' },
      map,
      '2026-08-05T00:00:00.000Z',
    );

    expect(document.sourceMap?.mapId).toBe('generic-town-source-20260805');
    expect(document.anchor.pin?.mapId).toBe('generic-town-source-20260805');
    expect((document.extensions?.openScenarioImport as { mapResolution: { mapVersionId: string } }).mapResolution.mapVersionId).toBe('map-a');
  });

  it('does not guess an ambiguous LogicFile match', () => {
    const analysis = analyzeOpenScenarioImport(bytes(valid.replace(/<Properties>[\s\S]*?<\/Properties>/, '').replace('Town01.xodr', 'same.xodr')));
    const resolution = resolveOpenScenarioMap(analysis, [
      { mapVersionId: 'a', sourceMapId: 'a', label: 'Same' },
      { mapVersionId: 'b', sourceMapId: 'b', label: 'Different', aliases: ['same'] },
    ]);
    expect(resolution).toMatchObject({ status: 'ambiguous', selectedMapVersionId: null });
    expect(resolution.candidates).toHaveLength(2);
  });

  it('fails conflicting embedded identities instead of applying precedence silently', () => {
    const conflicted = valid.replace(
      '</Properties>',
      `<Property name="uniscenarios.xodrSha256" value="${'b'.repeat(64)}"/></Properties>`,
    );
    const analysis = analyzeOpenScenarioImport(bytes(conflicted));
    const resolution = resolveOpenScenarioMap(analysis, [
      { mapVersionId: 'map-a', sourceMapId: 'map-a', label: 'A', xodrSha256: 'a'.repeat(64) },
      { mapVersionId: 'map-b', sourceMapId: 'map-b', label: 'B', xodrSha256: 'b'.repeat(64) },
    ]);
    expect(resolution).toMatchObject({
      status: 'conflict',
      source: 'embedded-identity',
      selectedMapVersionId: null,
      diagnostic: { code: 'map_identity_conflict', disposition: 'unsupported' },
    });
  });

  it.each([
    ['mapVersionId', withProperties('uniscenarios.mapVersionId=map-a')],
    ['xodrSha256', withProperties(`uniscenarios.xodrSha256=${'a'.repeat(64)}`)],
    ['mapId', withProperties('uniscenarios.mapId=map-a')],
  ])('rejects explicit selection that contradicts strong embedded %s', (_field, xml) => {
    const resolution = resolveOpenScenarioMap(analyzeOpenScenarioImport(bytes(xml)), [MAP_A, MAP_B], 'map-b');
    expect(resolution).toMatchObject({
      status: 'conflict',
      selectedMapVersionId: null,
      diagnostic: { code: 'map_identity_conflict' },
    });
    expect(resolution.diagnostic?.message).toContain('Explicit map version map-b conflicts');
  });

  it('resolves multiple consistent strong fields and accepts only the matching explicit map', () => {
    const analysis = analyzeOpenScenarioImport(bytes(withProperties(
      'uniscenarios.mapVersionId=map-a',
      'uniscenarios.mapId=map-a',
      `uniscenarios.xodrSha256=${'A'.repeat(64)}`,
    )));
    expect(resolveOpenScenarioMap(analysis, [MAP_A, MAP_B])).toMatchObject({ status: 'resolved', selectedMapVersionId: 'map-a' });
    expect(resolveOpenScenarioMap(analysis, [MAP_A, MAP_B], 'map-a')).toMatchObject({ status: 'resolved', selectedMapVersionId: 'map-a' });
  });

  it('allows explicit selection for weak LogicFile ambiguity or no match', () => {
    const weak = analyzeOpenScenarioImport(bytes(valid.replace(/<Properties>[\s\S]*?<\/Properties>/, '').replace('Town01.xodr', 'same.xodr')));
    const maps = [
      { ...MAP_A, label: 'Same' },
      { ...MAP_B, aliases: ['same'] },
    ];
    expect(resolveOpenScenarioMap(weak, maps)).toMatchObject({ status: 'ambiguous', selectedMapVersionId: null });
    expect(resolveOpenScenarioMap(weak, maps, 'map-b')).toMatchObject({ status: 'resolved', source: 'explicit', selectedMapVersionId: 'map-b' });

    const unknown = analyzeOpenScenarioImport(bytes(valid.replace(/<Properties>[\s\S]*?<\/Properties>/, '').replace('Town01.xodr', 'unknown.xodr')));
    expect(resolveOpenScenarioMap(unknown, maps)).toMatchObject({ status: 'unresolved', selectedMapVersionId: null });
    expect(resolveOpenScenarioMap(unknown, maps, 'map-a')).toMatchObject({ status: 'resolved', source: 'explicit', selectedMapVersionId: 'map-a' });
  });

  it('rejects contradictory duplicate aliases for the same embedded identity', () => {
    const xml = withProperties(
      'uniscenarios.mapVersionId=map-a',
      'uniscenarios.provenance.mapVersionId=map-b',
    );
    expect(() => analyzeOpenScenarioImport(bytes(xml))).toThrowError(
      expect.objectContaining({ code: 'map_identity_conflict' }),
    );
  });
});

describe('OpenSCENARIO intake: frames and entity forms (docs/engineering/openscenario-conformance.md F-01, F-12)', () => {
  const scene = (entities: string, privates: string) =>
    `<?xml version="1.0"?><OpenSCENARIO><FileHeader revMajor="1" revMinor="4" description="probe"/><RoadNetwork><LogicFile filepath="road.xodr"/></RoadNetwork><Entities>${entities}</Entities><Storyboard><Init><Actions>${privates}</Actions></Init></Storyboard></OpenSCENARIO>`;
  const teleport = (entity: string, position: string, extra = '') =>
    `<Private entityRef="${entity}"><PrivateAction><TeleportAction><Position>${position}</Position></TeleportAction></PrivateAction>${extra}</Private>`;

  it('maps OSC world (x east, y north, z up) to the y-up scene frame the compiler reads back as map y = -z', () => {
    const xml = scene('<ScenarioObject name="a"><Vehicle name="c" vehicleCategory="car"/></ScenarioObject>', teleport('a', '<WorldPosition x="50" y="-5.25" z="0.5" h="0.3"/>'));
    const [actor] = analyzeOpenScenarioImport(bytes(xml)).actors;
    // A right-hand lane south of the reference line stays south: scene z = +5.25.
    expect(actor).toMatchObject({ x: 50, y: 0.5, z: 5.25, heading: 0.3 });
    // Round trip with the XML 1.4 exporter's `y = -pose.z`.
    expect(0 - actor!.z).toBe(-5.25);
  });

  it('takes the spawn pose from the TeleportAction, never from another WorldPosition in the Private', () => {
    const route = '<PrivateAction><RoutingAction><AssignRouteAction><Route name="r" closed="false"><Waypoint routeStrategy="shortest"><Position><WorldPosition x="999" y="999"/></Position></Waypoint><Waypoint routeStrategy="shortest"><Position><WorldPosition x="1000" y="999"/></Position></Waypoint></Route></AssignRouteAction></RoutingAction></PrivateAction>';
    const xml = scene('<ScenarioObject name="a"><Vehicle name="c" vehicleCategory="car"/></ScenarioObject>',
      `<Private entityRef="a">${route}<PrivateAction><TeleportAction><Position><WorldPosition x="10" y="-2"/></Position></TeleportAction></PrivateAction></Private>`);
    expect(analyzeOpenScenarioImport(bytes(xml)).actors[0]).toMatchObject({ x: 10, z: 2 });
    const lane = scene('<ScenarioObject name="a"><Vehicle name="c" vehicleCategory="car"/></ScenarioObject>',
      `<Private entityRef="a">${route}<PrivateAction><TeleportAction><Position><LanePosition roadId="1" laneId="-1" s="10" offset="0"/></Position></TeleportAction></PrivateAction></Private>`);
    const analysis = analyzeOpenScenarioImport(bytes(lane));
    expect(analysis.actors).toHaveLength(0);
    expect(analysis.diagnostics).toContainEqual(expect.objectContaining({ code: 'actor_position_unsupported', disposition: 'unsupported' }));
  });

  it('keeps catalog-referenced entities and reports the unresolved catalog instead of dropping them', () => {
    const xml = scene(
      '<ScenarioObject name="car"><CatalogReference catalogName="VehicleCatalog" entryName="car_white"/></ScenarioObject><ScenarioObject name="walker"><CatalogReference catalogName="PedestrianCatalog" entryName="pedestrian_adult"/></ScenarioObject>',
      teleport('car', '<WorldPosition x="1" y="0"/>') + teleport('walker', '<WorldPosition x="2" y="3"/>'),
    );
    const analysis = analyzeOpenScenarioImport(bytes(xml));
    expect(analysis.actors.map((actor) => [actor.id, actor.kind, actor.catalogId])).toEqual([['car', 'car', 'car_white'], ['walker', 'pedestrian', 'pedestrian_adult']]);
    expect(analysis.diagnostics.filter((diagnostic) => diagnostic.code === 'catalog_reference_unresolved')).toHaveLength(2);
    expect(analysis.diagnostics.some((diagnostic) => diagnostic.code === 'entity_type_unsupported')).toBe(false);
  });

  it('flags an Init speed transition that is imported as an instantaneous initial speed', () => {
    const speed = '<PrivateAction><LongitudinalAction><SpeedAction><SpeedActionDynamics dynamicsShape="linear" dynamicsDimension="time" value="3"/><SpeedActionTarget><AbsoluteTargetSpeed value="10"/></SpeedActionTarget></SpeedAction></LongitudinalAction></PrivateAction>';
    const xml = scene('<ScenarioObject name="a"><Vehicle name="c" vehicleCategory="car"/></ScenarioObject>', teleport('a', '<WorldPosition x="0" y="0"/>', speed));
    const analysis = analyzeOpenScenarioImport(bytes(xml));
    expect(analysis.actors[0]!.speedKph).toBe(36);
    expect(analysis.diagnostics).toContainEqual(expect.objectContaining({ code: 'initial_speed_transition_approximated', disposition: 'approximated' }));
  });
});
