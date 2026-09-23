/**
 * Emit `src/vehicles-carla.generated.ts`: the `vehicle.*` -> CARLA GLB
 * bindings, derived from `catalog/vehicles-carla` (its `manifest.json` and the
 * bytes of each model).
 *
 * Generated rather than hand-written because every field except the family
 * choice is mechanical — content hash, articulated node names and the paint
 * slot all come out of the pack — so a re-cut pack is one command away from a
 * correct catalog instead of three independently maintained mappings.
 *
 * The family choice is the editorial part and lives in ASSIGNMENTS below.
 * Catalog `dims` stay authoritative: a bound model is uniformly scaled to the
 * actor's longest authored axis at load, so a mapping is only sensible when
 * the model's proportions are close to the catalog entry's. Ids whose vehicle
 * has no CARLA counterpart (articulated semi, service-body trucks, tram,
 * school bus, mobility scooter, police/fire SUVs) are deliberately absent and
 * keep their procedural builder.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '..', '..', '..', 'catalog', 'vehicles-carla');
const out = resolve(here, '..', 'src', 'vehicles-carla.generated.ts');

const rustOut = resolve(here, '..', '..', '..', 'renderer', 'render-core', 'src', 'vehicle_assignments.generated.rs');
/** Catalog id -> `manifest.json` key, with the reason where it is not obvious. */
const ASSIGNMENTS: ReadonlyArray<readonly [string, string, string?]> = [
  ['vehicle.sedan', 'vehicle_sedan_lincoln_mkz'],
  ['vehicle.hatchback', 'vehicle_hatchback_mini_cooper'],
  ['vehicle.suv', 'vehicle_suv_nissan_patrol'],
  ['vehicle.pickup', 'vehicle_pickup_tesla_cybertruck', 'the only CARLA pickup; authored livery, not tintable'],
  ['vehicle.van', 'vehicle_van_mercedes_sprinter'],
  ['vehicle.delivery_van', 'vehicle_van_mercedes_sprinter'],
  ['vehicle.shuttle_bus', 'vehicle_van_mercedes_sprinter', 'a 7.4 m shuttle is a long-wheelbase minibus; the Fuso Rosa is 10 m and would scale to 0.7'],
  ['vehicle.minivan', 'vehicle_minivan_bmw_gran_tourer'],
  ['vehicle.kia.carnival', 'vehicle_minivan_bmw_gran_tourer'],
  ['vehicle.box_truck', 'vehicle_truck_carlacola'],
  ['vehicle.bus', 'vehicle_bus_mitsubishi_fusorosa', 'CARLA has one bus; its authored livery is its identity, so it is not tintable'],
  ['vehicle.motorcycle', 'vehicle_motorcycle_harley_rider', 'ridden: CARLA BP_Harley rider, helmeted'],
  ['vehicle.bicycle', 'vehicle_bicycle_gazelle_omafiets_rider', 'upright city bike: the closest silhouette to the catalog box, and scales ~1; ridden: CARLA BP_LeisureBike rider'],
  ['vehicle.ambulance', 'vehicle_ambulance_ford'],
  ['vehicle.fire_engine', 'vehicle_firetruck_actros'],
  ['vehicle.honda_civic', 'vehicle_sedan_dodge_charger'],
  ['vehicle.toyota_camry', 'vehicle_sedan_chevrolet_impala', 'a second rigged sedan, so Camry and Sedan are not the same model on screen'],
  ['vehicle.tesla_model_3', 'vehicle_sedan_tesla_model3', 'exact vehicle; CARLA ships it as a static mesh, so no wheel rig'],
  ['vehicle.ford_mustang', 'vehicle_coupe_ford_mustang'],
  ['vehicle.chevrolet_corvette', 'vehicle_coupe_audi_tt', 'low sports coupe proportions'],
  // vehicle.porsche_911 has no usable counterpart and keeps its builder.
  // CARLA ships four coupes: the Mustang and TT are spoken for above, and the
  // two C-Classes are both unusable here — `coupe_mercedes_c_2020` models its
  // driver door swung open inside the single `body` mesh (no `door_*` node to
  // close it), and `coupe_mercedes_c` is a body-only 5.03 m saloon coupe with
  // no wheel rig, 13% too tall once fitted to the 911's 4.52 m length.
  ['vehicle.jeep_wrangler', 'vehicle_suv_jeep_wrangler', 'the same vehicle; CARLA models the short-wheelbase two-door'],
  ['vehicle.taxi', 'vehicle_sedan_ford_crown', 'authored taxi livery'],
  ['vehicle.police_cruiser', 'vehicle_police_dodge_charger', 'authored police livery'],
];

interface ManifestVehicle {
  readonly file: string;
  readonly display: string;
  readonly tintable: boolean;
  readonly nodes: readonly string[];
  readonly materials: readonly string[];
  /** Ridden two-wheelers (tools/riders): the rider is part of the model. */
  readonly rider?: {
    readonly clip: string;
    readonly clipDurationS: number;
    readonly metersPerCycle: number;
    readonly slots: readonly string[];
  };
}

const attribution = JSON.parse(readFileSync(resolve(packRoot, 'ATTRIBUTION.json'), 'utf8')) as {
  readonly assets: Readonly<Record<string, { readonly attribution: string }>>;
};

/** A ridden GLB's `asset.extras.rider` (palettes are authored in the GLB, not copied by hand). */
function riderExtras(bytes: Buffer): { readonly palettes: readonly (Record<string, readonly number[]> | null)[] } {
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as {
    readonly asset: { readonly extras?: { readonly rider?: { readonly palettes: readonly (Record<string, readonly number[]> | null)[] } } };
  };
  const rider = json.asset.extras?.rider;
  if (!rider) throw new Error('ridden model GLB lacks asset.extras.rider');
  return rider;
}

const manifest = JSON.parse(readFileSync(resolve(packRoot, 'manifest.json'), 'utf8')) as {
  readonly vehicles: Readonly<Record<string, ManifestVehicle>>;
};

/** Node names the renderer articulates, in the pack's `CONVENTIONS.md` vocabulary. */
function articulation(nodes: readonly string[]): string[] {
  const has = (name: string): boolean => nodes.includes(name);
  const lines: string[] = [];
  const front = ['wheel_fl', 'wheel_fr'].filter(has);
  const rear = ['wheel_rl', 'wheel_rr'].filter(has);
  const twoWheeler = { front: ['wheel_f'].filter(has), rear: ['wheel_r'].filter(has) };
  const wheelsFront = front.length > 0 ? front : twoWheeler.front;
  const wheelsRear = rear.length > 0 ? rear : twoWheeler.rear;
  if (wheelsFront.length > 0) lines.push(`      wheelsFront: [${wheelsFront.map((name) => `'${name}'`).join(', ')}],`);
  if (wheelsRear.length > 0) lines.push(`      wheelsRear: [${wheelsRear.map((name) => `'${name}'`).join(', ')}],`);
  if (has('handlebar')) lines.push("      steered: ['handlebar'],");
  // The trace's door vocabulary is left/right/rear; CARLA rigs the four
  // passenger doors, so the rear pair answers a `rear` door state together.
  const doors: string[] = [];
  if (has('door_fl')) doors.push("left: ['door_fl']");
  if (has('door_fr')) doors.push("right: ['door_fr']");
  const rearDoors = ['door_rl', 'door_rr'].filter(has);
  if (rearDoors.length > 0) doors.push(`rear: [${rearDoors.map((name) => `'${name}'`).join(', ')}]`);
  if (doors.length > 0) lines.push(`      doors: { ${doors.join(', ')} },`);
  return lines;
}

const blocks: string[] = [];
const report: string[] = [];
const nativeEntries: Record<string, unknown> = {};
for (const [catalogId, key, reason] of ASSIGNMENTS) {
  const vehicle = manifest.vehicles[key];
  if (!vehicle) throw new Error(`${catalogId}: ${key} is not in the pack manifest`);
  const bytes = readFileSync(resolve(packRoot, vehicle.file));
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  // A ridden model's clip poses its wheels, crank and rider together, so the
  // renderer's own wheel/handlebar articulation would fight it.
  const rider = vehicle.rider
    ? { ...vehicle.rider, palettes: riderExtras(bytes).palettes }
    : undefined;
  const nodes = rider ? [] : articulation(vehicle.nodes);
  const paint = vehicle.tintable && vehicle.materials.includes('body_paint');
  const glbPath = `catalog/vehicles-carla/${vehicle.file}`;
  nativeEntries[catalogId] = {
    model: {
      glbPath,
      attribution: rider
        ? attribution.assets[key]?.attribution
        : `"${vehicle.display}" vehicle model © CARLA Simulator contributors (carla.org), licensed CC BY 4.0; converted to glTF for SimForge.`,
      source: 'carla-0.10.0-ue5',
    },
    tintable: Boolean(paint),
    scaleToDims: true,
    ...(rider ? {
      animations: { [rider.clip]: { glbPath, clip: rider.clip } },
      rider: {
        clip: rider.clip,
        clipDurationS: rider.clipDurationS,
        metersPerCycle: rider.metersPerCycle,
        slots: rider.slots,
        palettes: rider.palettes,
      },
    } : {}),
    ...(reason ? { note: reason } : {}),
  };
  if (rider && !attribution.assets[key]) throw new Error(`${key}: no ATTRIBUTION.json entry`);
  blocks.push([
    `  /** ${vehicle.display}${reason ? ` — ${reason}` : ''} */`,
    `  '${catalogId}': {`,
    "    kind: 'glb',",
    `    url: '/catalog/vehicles-carla/${vehicle.file}',`,
    `    contentHash: '${contentHash}',`,
    ...(nodes.length > 0 ? ['    nodes: {', ...nodes, '    },'] : []),
    ...(paint ? ["    paint: 'body_paint',"] : []),
    ...(rider ? [
      '    animated: true,',
      '    rider: {',
      `      clip: '${rider.clip}',`,
      `      clipDurationS: ${rider.clipDurationS},`,
      `      metersPerCycle: ${rider.metersPerCycle},`,
      `      slots: [${rider.slots.map((slot) => `'${slot}'`).join(', ')}],`,
      '      palettes: [',
      ...rider.palettes.map((palette) => palette === null
        ? '        null,'
        : `        { ${Object.entries(palette).map(([slot, rgb]) => `${slot}: [${rgb.join(', ')}]`).join(', ')} },`),
      '      ],',
      '    },',
    ] : []),
    '  },',
  ].join('\n'));
  report.push(`${catalogId} -> ${key} (${(bytes.byteLength / 1e6).toFixed(1)} MB${paint ? ', tintable' : ', livery'}${rider ? ', ridden' : nodes.length > 0 ? '' : ', static'})`);
}

const source = `import type { ExternalModelBinding } from './types';

/**
 * CARLA vehicle models, generated by \`scripts/generate-vehicle-models.ts\` from
 * \`catalog/vehicles-carla\` — do not edit by hand.
 *
 * Frame and slot contract: \`catalog/vehicles-carla/CONVENTIONS.md\` (y-up, +X
 * forward, origin at ground under the CARLA pivot; \`body\`/\`wheel_*\`/\`door_*\`
 * nodes; neutral \`body_paint\` paint slot, authored \`body_livery\` never
 * tinted). Ids absent here have no CARLA counterpart and keep their builder.
 */
export const CARLA_VEHICLE_MODELS = {
${blocks.join('\n')}
} as const satisfies Readonly<Record<string, ExternalModelBinding>>;
`;

const outputs = [
  [out, source],
  [resolve(packRoot, 'catalog-models.json'), `${JSON.stringify({
    comment: 'Generated by packages/asset-catalog/scripts/generate-vehicle-models.ts. Canonical assignments are shared with the browser and Rust manifest fallback.',
    entries: nativeEntries,
  }, null, 2)}\n`],
  [rustOut, `// Generated by packages/asset-catalog/scripts/generate-vehicle-models.ts; do not edit.\nconst FALLBACK_ASSIGNMENTS: &[(&str, &str)] = &[\n${ASSIGNMENTS.map(([id, key]) => `    ("${id}", "${key}"),`).join('\n')}\n];\n`],
] as const;
for (const [path, content] of outputs) {
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`Stale vehicle mapping: ${path}`);
  } else {
    writeFileSync(path, content, 'utf8');
  }
}
process.stdout.write(`${report.join('\n')}\nvehicles-carla.generated.ts: ${ASSIGNMENTS.length} bindings\n`);
