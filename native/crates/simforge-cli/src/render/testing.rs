//! Test doubles for the planners.

use std::collections::BTreeMap;

use super::error::{PlanError, PlanResult};
use super::map_closure::MemberSource;

/// An in-memory closure: digest and text per member.
#[derive(Default)]
pub struct FakeSource {
    files: BTreeMap<String, (String, String)>,
}

impl FakeSource {
    pub fn file(mut self, uri: &str, sha256: &str, text: &str) -> Self {
        self.files
            .insert(uri.to_owned(), (sha256.to_owned(), text.to_owned()));
        self
    }
}

impl MemberSource for FakeSource {
    fn sha256(&self, uri: &str) -> Option<&str> {
        self.files.get(uri).map(|(sha, _)| sha.as_str())
    }

    fn read_text(&self, uri: &str) -> PlanResult<String> {
        self.files
            .get(uri)
            .map(|(_, text)| text.clone())
            .ok_or_else(|| PlanError::new("native_render_member_missing", uri))
    }
}
