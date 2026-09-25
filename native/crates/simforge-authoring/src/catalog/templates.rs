//! The catalog's executable templates, embedded by their registry `source`
//! path (`examples/...`, relative to the repository's `oss/` root), so the
//! template digests (sha256 of the file bytes) are the ones the TypeScript
//! catalog recorded and the binary needs no checkout. `catalog verify`
//! compares a catalog against these embedded executables.

/// `(source, bytes)` for every registry entry.
pub const TEMPLATES: [(&str, &[u8]); 37] = [
    ("examples/ltap-opposing.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/ltap-opposing.template.json"))),
    ("examples/cpnco-parked-row.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/cpnco-parked-row.template.json"))),
    ("examples/multiple-threat.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/multiple-threat.template.json"))),
    ("examples/bus-stop-emergence.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/bus-stop-emergence.template.json"))),
    ("examples/school-dartout.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/school-dartout.template.json"))),
    ("examples/mechanisms/remaining/cross-traffic-stop-violation.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/cross-traffic-stop-violation.template.json"))),
    ("examples/mechanisms/remaining/red-light-late-entry.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/red-light-late-entry.template.json"))),
    ("examples/mechanisms/junction-vru/right-turn-crosswalk.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/junction-vru/right-turn-crosswalk.template.json"))),
    ("examples/mechanisms/junction-vru/left-turn-crosswalk.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/junction-vru/left-turn-crosswalk.template.json"))),
    ("examples/mechanisms/remaining/opposing-turn-encroachment.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/opposing-turn-encroachment.template.json"))),
    ("examples/mechanisms/junction-vru/intersection-blocked-box-reveal.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/junction-vru/intersection-blocked-box-reveal.template.json"))),
    ("examples/mechanisms/junction-vru/adult-midblock-crossing.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/junction-vru/adult-midblock-crossing.template.json"))),
    ("examples/mechanisms/remaining/reversing-pedestrian.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/reversing-pedestrian.template.json"))),
    ("examples/mechanisms/remaining/cyclist-right-hook.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/cyclist-right-hook.template.json"))),
    ("examples/mechanisms/junction-vru/cyclist-crossing-path.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/junction-vru/cyclist-crossing-path.template.json"))),
    ("examples/mechanisms/remaining/dooring-cyclist.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/dooring-cyclist.template.json"))),
    ("examples/mechanisms/corridor/lead-hard-brake.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/corridor/lead-hard-brake.template.json"))),
    ("examples/mechanisms/corridor/queue-tail.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/corridor/queue-tail.template.json"))),
    ("examples/mechanisms/corridor/cutout-reveals-stopped.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/corridor/cutout-reveals-stopped.template.json"))),
    ("examples/mechanisms/corridor/cut-in-brake.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/corridor/cut-in-brake.template.json"))),
    ("examples/mechanisms/remaining/slow-vulnerable-lead.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/slow-vulnerable-lead.template.json"))),
    ("examples/mechanisms/corridor/sideswipe.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/corridor/sideswipe.template.json"))),
    ("examples/mechanisms/corridor/merge-gap-collapse.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/corridor/merge-gap-collapse.template.json"))),
    ("examples/mechanisms/remaining/lane-drop-late-merge.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/lane-drop-late-merge.template.json"))),
    ("examples/mechanisms/remaining/oncoming-overtake.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/remaining/oncoming-overtake.template.json"))),
    ("examples/mechanisms/parking-transit/vehicle-pulls-out.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/parking-transit/vehicle-pulls-out.template.json"))),
    ("examples/mechanisms/parking-transit/backing-out-vehicle.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/parking-transit/backing-out-vehicle.template.json"))),
    ("examples/mechanisms/parking-transit/delivery-double-park.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/parking-transit/delivery-double-park.template.json"))),
    ("examples/mechanisms/parking-transit/driveway-emergence.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/parking-transit/driveway-emergence.template.json"))),
    ("examples/mechanisms/parking-transit/bus-pullout.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/parking-transit/bus-pullout.template.json"))),
    ("examples/mechanisms/school-workzone/crossing-guard-release.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/school-workzone/crossing-guard-release.template.json"))),
    ("examples/mechanisms/school-workzone/lane-shift.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/school-workzone/lane-shift.template.json"))),
    ("examples/mechanisms/school-workzone/worker-intrusion.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/school-workzone/worker-intrusion.template.json"))),
    ("examples/mechanisms/obstacle/curve-loss-control.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/obstacle/curve-loss-control.template.json"))),
    ("examples/mechanisms/obstacle/fallen-cargo.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/obstacle/fallen-cargo.template.json"))),
    ("examples/mechanisms/obstacle/animal-crossing.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/obstacle/animal-crossing.template.json"))),
    ("examples/mechanisms/obstacle/disabled-vehicle.template.json", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/mechanisms/obstacle/disabled-vehicle.template.json"))),
];

/// The embedded bytes of a registry `source`, if this binary carries it.
pub fn template_bytes(source: &str) -> Option<&'static [u8]> {
    TEMPLATES
        .iter()
        .find(|(s, _)| *s == source)
        .map(|(_, b)| *b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registry_source_is_embedded() {
        let registry = &crate::catalog::taxonomy::taxonomy().templates;
        assert_eq!(registry.len(), TEMPLATES.len());
        for (entry, (source, _)) in registry.iter().zip(TEMPLATES.iter()) {
            assert_eq!(&entry.source, source);
        }
    }
}
