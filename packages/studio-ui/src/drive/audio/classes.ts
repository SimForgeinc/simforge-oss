/**
 * The engine families the sample library is recorded for, and the map from a
 * catalogue vehicle id onto one of them.
 *
 * Six families cover the fleet because what a listener identifies is the
 * firing pattern, not the model: a four-cylinder saloon, a V8, a heavy diesel,
 * a transit diesel at bus gearing, an electric drivetrain and a bike. Anything
 * the map does not name falls back to the four-cylinder, which is the least
 * wrong answer for an unknown car.
 */
export type VehicleAudioClass = 'petrol-i4' | 'v8' | 'diesel-truck' | 'bus' | 'ev' | 'motorcycle';

export const VEHICLE_AUDIO_CLASSES: readonly VehicleAudioClass[] = [
  'petrol-i4',
  'v8',
  'diesel-truck',
  'bus',
  'ev',
  'motorcycle',
];

/**
 * Catalogue id to engine family. Ids are the `vehicle.*` ids built by
 * `@simforge-oss/asset-catalog`; the CARLA-sourced models keep those ids, so
 * this map does not change when a family's mesh is swapped.
 */
export const VEHICLE_AUDIO_CLASS_BY_CATALOG_ID: Readonly<Record<string, VehicleAudioClass>> = {
  // Ordinary petrol cars.
  'vehicle.sedan': 'petrol-i4',
  'vehicle.hatchback': 'petrol-i4',
  'vehicle.suv': 'petrol-i4',
  'vehicle.minivan': 'petrol-i4',
  'vehicle.van': 'petrol-i4',
  'vehicle.taxi': 'petrol-i4',
  'vehicle.kia': 'petrol-i4',
  'vehicle.honda_civic': 'petrol-i4',
  'vehicle.toyota_camry': 'petrol-i4',
  'vehicle.jeep_wrangler': 'petrol-i4',
  'vehicle.delivery_van': 'petrol-i4',
  'vehicle.mobility_scooter': 'petrol-i4',
  'vehicle.hovercraft': 'petrol-i4',

  // Large-displacement petrol: muscle, sports, and the body-on-frame pickups
  // and emergency cars that share their V8s.
  'vehicle.pickup': 'v8',
  'vehicle.ford_mustang': 'v8',
  'vehicle.chevrolet_corvette': 'v8',
  'vehicle.porsche_911': 'v8',
  'vehicle.police_cruiser': 'v8',
  'vehicle.police_suv': 'v8',
  'vehicle.tow_truck': 'v8',

  // Heavy diesel.
  'vehicle.semi_truck': 'diesel-truck',
  'vehicle.box_truck': 'diesel-truck',
  'vehicle.boxTruck': 'diesel-truck',
  'vehicle.dump_truck': 'diesel-truck',
  'vehicle.flatbed_truck': 'diesel-truck',
  'vehicle.tanker_truck': 'diesel-truck',
  'vehicle.garbage_truck': 'diesel-truck',
  'vehicle.cement_mixer': 'diesel-truck',
  'vehicle.utility_bucket_truck': 'diesel-truck',
  'vehicle.fire_engine': 'diesel-truck',
  'vehicle.ambulance': 'diesel-truck',
  'vehicle.fire_command_suv': 'diesel-truck',

  // Transit diesel: same fuel, much taller gearing and a bigger body cavity.
  'vehicle.bus': 'bus',
  'vehicle.school_bus': 'bus',
  'vehicle.shuttle_bus': 'bus',

  // Electric drivetrains, including the tram, which is the recording the
  // electric bands were cut from in the first place.
  'vehicle.tesla_model_3': 'ev',
  'vehicle.tram': 'ev',

  // Two wheels. The bicycle has no engine; it takes the quietest family and
  // the caller mutes the engine layer for it.
  'vehicle.motorcycle': 'motorcycle',
  'vehicle.bicycle': 'ev',
};

/** The engine family for a catalogue id, four-cylinder petrol when unknown. */
export function vehicleAudioClassFor(catalogId: string): VehicleAudioClass {
  return VEHICLE_AUDIO_CLASS_BY_CATALOG_ID[catalogId] ?? 'petrol-i4';
}
