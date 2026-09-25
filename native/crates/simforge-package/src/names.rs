//! Member names and roles. Every name in a container matches the section 10
//! allowlist; none is derived from user text. Roles fix the media type, the
//! member's own contract string and the container order.

use serde::{Deserialize, Serialize};

pub const MANIFEST_PATH: &str = "manifest.json";
pub const RECEIPT_PATH: &str = "receipt.json";
pub const BLOB_PREFIX: &str = "blobs/sha256/";

/// Lowercase hex sha256.
pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `blobs/sha256/<aa>/<sha256>`.
pub fn blob_path(sha256: &str) -> String {
    format!("{BLOB_PREFIX}{}/{sha256}", &sha256[..2])
}

/// The digest a blob name carries, when `name` is a well-formed blob name
/// (the two-hex directory must be the digest's first two characters).
pub fn blob_digest(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(BLOB_PREFIX)?;
    let (dir, digest) = rest.split_once('/')?;
    (dir.len() == 2 && is_hex64(digest) && digest.starts_with(dir)).then_some(digest)
}

/// The section 10 allowlist:
/// `^(manifest\.json|receipt\.json|document\.json|simulation/[a-z-]+\.json(\.gz)?|timeline/[0-9a-f]{64}\.json|(map|actors)/closure\.json|map/web-closure\.json|catalog/entries\.json|export/scenario\.xosc|render/pin\.json|blobs/sha256/[0-9a-f]{2}/[0-9a-f]{64})$`
/// It rejects absolute paths, `..`, backslashes, drive letters, NUL and
/// non-ASCII by construction.
pub fn is_allowed_name(name: &str) -> bool {
    match name {
        MANIFEST_PATH
        | RECEIPT_PATH
        | "document.json"
        | "map/closure.json"
        | "map/web-closure.json"
        | "actors/closure.json"
        | "catalog/entries.json"
        | "export/scenario.xosc"
        | "render/pin.json" => true,
        _ => {
            if let Some(rest) = name.strip_prefix("simulation/") {
                let stem = rest
                    .strip_suffix(".json.gz")
                    .or_else(|| rest.strip_suffix(".json"));
                return stem.is_some_and(|s| {
                    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
                });
            }
            if let Some(rest) = name.strip_prefix("timeline/") {
                return rest.strip_suffix(".json").is_some_and(is_hex64);
            }
            blob_digest(name).is_some()
        }
    }
}

/// A non-blob member's role (section 4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Document,
    Trace,
    Resolution,
    Traffic,
    Timeline,
    MapClosure,
    MapWebClosure,
    ActorClosure,
    Catalog,
    Xosc,
    RenderPin,
}

impl Role {
    /// Container order of section 3.2 (the declaration order).
    pub const ORDER: [Role; 11] = [
        Role::Document,
        Role::Trace,
        Role::Resolution,
        Role::Traffic,
        Role::Timeline,
        Role::MapClosure,
        Role::MapWebClosure,
        Role::ActorClosure,
        Role::Catalog,
        Role::Xosc,
        Role::RenderPin,
    ];

    pub fn of_path(path: &str) -> Option<Role> {
        Some(match path {
            "document.json" => Role::Document,
            "simulation/trace.json.gz" => Role::Trace,
            "simulation/resolution.json.gz" => Role::Resolution,
            "simulation/materialized-traffic.json" => Role::Traffic,
            "map/closure.json" => Role::MapClosure,
            "map/web-closure.json" => Role::MapWebClosure,
            "actors/closure.json" => Role::ActorClosure,
            "catalog/entries.json" => Role::Catalog,
            "export/scenario.xosc" => Role::Xosc,
            "render/pin.json" => Role::RenderPin,
            _ => {
                let sha = path.strip_prefix("timeline/")?.strip_suffix(".json")?;
                return is_hex64(sha).then_some(Role::Timeline);
            }
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Document => "document",
            Role::Trace => "trace",
            Role::Resolution => "resolution",
            Role::Traffic => "traffic",
            Role::Timeline => "timeline",
            Role::MapClosure => "map-closure",
            Role::MapWebClosure => "map-web-closure",
            Role::ActorClosure => "actor-closure",
            Role::Catalog => "catalog",
            Role::Xosc => "xosc",
            Role::RenderPin => "render-pin",
        }
    }

    pub fn media_type(self) -> &'static str {
        match self {
            Role::Document => "application/vnd.simforge.scenario+json",
            Role::Trace => "application/vnd.simforge.trace+json+gzip",
            Role::Resolution => "application/vnd.simforge.sim-resolution+json+gzip",
            Role::Traffic => "application/vnd.uniscenarios.materialized-traffic+json",
            Role::Timeline => "application/vnd.simforge.render-timeline+json",
            Role::MapClosure | Role::MapWebClosure => "application/vnd.simforge.map-closure+json",
            Role::ActorClosure => "application/vnd.simforge.actor-assets-closure+json",
            Role::Catalog => "application/json",
            Role::Xosc => "application/xml",
            Role::RenderPin => "application/vnd.simforge.render-pin+json",
        }
    }

    /// Roles every package must carry (a timeline at least once).
    pub fn required(self) -> bool {
        matches!(
            self,
            Role::Document
                | Role::Trace
                | Role::Resolution
                | Role::Timeline
                | Role::MapClosure
                | Role::ActorClosure
                | Role::Catalog
        )
    }

    /// Members whose bytes are already compressed (`*+gzip`): STORE, never DEFLATE.
    pub fn stored(self) -> bool {
        matches!(self, Role::Trace | Role::Resolution)
    }

    /// Position in the container order.
    pub fn rank(self) -> usize {
        Role::ORDER
            .iter()
            .position(|r| *r == self)
            .expect("every role is in ORDER")
    }
}

/// Content sniffing for blobs, which carry no extension: already-compressed
/// formats are STOREd (gzip, zstd, PNG, JPEG, KTX2, WebP). The rule depends
/// on the bytes only, so the same blob always takes the same method.
pub fn blob_is_precompressed(head: &[u8]) -> bool {
    head.starts_with(&[0x1f, 0x8b])
        || head.starts_with(&[0x28, 0xb5, 0x2f, 0xfd])
        || head.starts_with(&[0x89, b'P', b'N', b'G'])
        || head.starts_with(&[0xff, 0xd8, 0xff])
        || head.starts_with(&[0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb])
        || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist() {
        let sha = "a".repeat(64);
        for ok in [
            "manifest.json".to_owned(),
            "simulation/trace.json.gz".to_owned(),
            "simulation/materialized-traffic.json".to_owned(),
            format!("timeline/{sha}.json"),
            format!("blobs/sha256/aa/{sha}"),
        ] {
            assert!(is_allowed_name(&ok), "{ok}");
        }
        for bad in [
            "../manifest.json".to_owned(),
            "/manifest.json".to_owned(),
            "simulation/../x.json".to_owned(),
            "simulation/Trace.json".to_owned(),
            "simulation/.json".to_owned(),
            "timeline/".to_owned(),
            format!("timeline/{}.json", "A".repeat(64)),
            format!("blobs/sha256/ab/{sha}"),
            format!("blobs\\sha256\\aa\\{sha}"),
            "C:/manifest.json".to_owned(),
            "manifest.json\0".to_owned(),
            "document.json/".to_owned(),
        ] {
            assert!(!is_allowed_name(&bad), "{bad}");
        }
    }

    #[test]
    fn roles_round_trip() {
        for role in Role::ORDER {
            let json = serde_json::to_string(&role).unwrap();
            assert_eq!(json, format!("\"{}\"", role.as_str()));
        }
    }
}
