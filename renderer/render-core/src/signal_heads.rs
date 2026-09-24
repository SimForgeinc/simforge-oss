//! Traffic-signal heads of the map GLB and the lens each one lights.
//!
//! A RoadRunner export draws every lamp of a signal head twice, coplanar: a
//! lit lens (`light_red_on_Signal*`, emissive) and an unlit one
//! (`light_red_off_Signal*`), under a head node named `{guid}<asset>`,
//! where `{guid}` is the OpenDRIVE `<vectorSignal signalId>` of the head.
//! Left alone, both are drawn and all three lamps read lit. The renderer
//! shows, per lamp, exactly one of the pair: the lit lens for the one lamp
//! the frame's indication lights, the unlit lens for the others.

use serde::Deserialize;

/// The lamp colours of a three-lamp head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LampColor {
    Red,
    Yellow,
    Green,
}

/// The one lamp a head lights, or none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalLens {
    Red,
    Yellow,
    Green,
    Off,
}

impl SignalLens {
    pub fn lights(self, color: LampColor) -> bool {
        matches!(
            (self, color),
            (SignalLens::Red, LampColor::Red)
                | (SignalLens::Yellow, LampColor::Yellow)
                | (SignalLens::Green, LampColor::Green)
        )
    }
}

/// The engine's null-signal indication: a head the scenario does not drive
/// is driven through as green (the simulation's forced-green default).
pub const UNDRIVEN_HEAD_LENS: SignalLens = SignalLens::Green;

/// `{8-4-4-4-12}` GUID prefix of a node name, lowercased with its braces.
pub fn head_guid(node_name: &str) -> Option<String> {
    let rest = node_name.strip_prefix('{')?;
    let close = rest.find('}')?;
    let guid = &rest[..close];
    let groups: Vec<&str> = guid.split('-').collect();
    let shape_ok = groups.len() == 5
        && groups
            .iter()
            .zip([8usize, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()));
    shape_ok.then(|| format!("{{{}}}", guid.to_ascii_lowercase()))
}

/// `(colour, lit)` of a lens node (`light_<colour>_<on|off>_Signal...`).
pub fn lens_node(node_name: &str) -> Option<(LampColor, bool)> {
    let rest = node_name.strip_prefix("light_")?;
    let (color, rest) = if let Some(r) = rest.strip_prefix("red_") {
        (LampColor::Red, r)
    } else if let Some(r) = rest.strip_prefix("yellow_") {
        (LampColor::Yellow, r)
    } else if let Some(r) = rest.strip_prefix("green_") {
        (LampColor::Green, r)
    } else {
        return None;
    };
    if rest.starts_with("on_Signal") {
        Some((color, true))
    } else if rest.starts_with("off_Signal") {
        Some((color, false))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_roadrunner_head_and_lens_names() {
        assert_eq!(
            head_guid(
                "{792C9DF6-88ce-45b8-a711-1db32acf567e}Signal_3Light_Post01_RedYellowGreen Left"
            )
            .as_deref(),
            Some("{792c9df6-88ce-45b8-a711-1db32acf567e}")
        );
        assert_eq!(head_guid("Signal_3Light_Post01"), None);
        assert_eq!(head_guid("{not-a-guid}Signal"), None);
        assert_eq!(
            lens_node("light_red_on_Signal"),
            Some((LampColor::Red, true))
        );
        assert_eq!(
            lens_node("light_yellow_off_Signal_12"),
            Some((LampColor::Yellow, false))
        );
        assert_eq!(
            lens_node("light_green_on_Signal1439"),
            Some((LampColor::Green, true))
        );
        // The lamp group node and unrelated nodes are not lenses.
        assert_eq!(lens_node("light_red"), None);
        assert_eq!(lens_node("light_red_1"), None);
        assert_eq!(lens_node("lights"), None);
    }

    #[test]
    fn a_lens_lights_only_its_own_lamp() {
        assert!(SignalLens::Red.lights(LampColor::Red));
        assert!(!SignalLens::Red.lights(LampColor::Yellow));
        assert!(!SignalLens::Red.lights(LampColor::Green));
        for color in [LampColor::Red, LampColor::Yellow, LampColor::Green] {
            assert!(!SignalLens::Off.lights(color));
        }
    }
}
