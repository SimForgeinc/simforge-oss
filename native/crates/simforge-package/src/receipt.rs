//! `receipt.json`: the export event. Outside the identity and never used for
//! a decision, but when present it must be well-formed and must not
//! contradict the container it sits in (a display that lies is refused).

use serde::{Deserialize, Serialize};
use simforge_core::hash::canonical_json_of;

use crate::error::{PackageError, Result};
use crate::manifest::{is_token, parse_canonical, plain_text, timestamp, BlobCount};

pub const RECEIPT_SCHEMA: &str = "simforge.scenario-package-receipt/v1";

/// Thin: no `blobs/`. Full: every blob its form requires (see `check`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Form {
    Thin,
    Full,
}

impl Form {
    pub fn as_str(self) -> &'static str {
        match self {
            Form::Thin => "thin",
            Form::Full => "full",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub schema: String,
    pub package_id: String,
    pub form: Form,
    pub exported_at: String,
    pub exporter_release: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_tier: Option<String>,
    pub embedded_blobs: BlobCount,
}

/// What the exporter says about the export event; the rest is computed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptInput {
    pub exported_at: String,
    pub exporter_release: String,
    pub texture_tier: Option<String>,
}

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError::container("receipt_invalid", message).at("receipt.json")
}

impl Receipt {
    pub fn new(
        input: &ReceiptInput,
        package_id: &str,
        form: Form,
        blobs: BlobCount,
    ) -> Result<Self> {
        let receipt = Self {
            schema: RECEIPT_SCHEMA.to_owned(),
            package_id: package_id.to_owned(),
            form,
            exported_at: input.exported_at.clone(),
            exporter_release: input.exporter_release.clone(),
            texture_tier: input.texture_tier.clone(),
            embedded_blobs: blobs,
        };
        receipt
            .validate()
            .map_err(|e| PackageError::argument("receipt", e.message))?;
        Ok(receipt)
    }

    pub fn to_canonical_bytes(&self) -> Result<Vec<u8>> {
        canonical_json_of(self)
            .map(String::into_bytes)
            .map_err(|e| invalid(e.to_string()))
    }

    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let value = parse_canonical(bytes, "receipt.json").map_err(|e| match e {
            Some(e) => invalid(e.message),
            None => invalid("receipt.json is not JSON"),
        })?;
        let receipt: Receipt = serde_json::from_value(value).map_err(|e| invalid(e.to_string()))?;
        if receipt.to_canonical_bytes()? != bytes {
            return Err(invalid(
                "receipt.json carries a value its typed form cannot represent",
            ));
        }
        receipt.validate()?;
        Ok(receipt)
    }

    fn validate(&self) -> Result<()> {
        if self.schema != RECEIPT_SCHEMA {
            return Err(invalid(format!(
                "schema is {:?}, expected {RECEIPT_SCHEMA}",
                self.schema
            )));
        }
        timestamp("receipt.exportedAt", &self.exported_at).map_err(|e| invalid(e.message))?;
        plain_text("receipt.exporterRelease", &self.exporter_release, 1, 64)
            .map_err(|e| invalid(e.message))?;
        if let Some(t) = &self.texture_tier {
            if !is_token(t, 64) {
                return Err(invalid("receipt.textureTier is not a token"));
            }
        }
        if self.form == Form::Thin && self.texture_tier.is_some() {
            return Err(invalid("a thin receipt names no texture tier"));
        }
        Ok(())
    }

    /// The receipt must describe the container it is in.
    pub fn check_against(&self, package_id: &str, form: Form, blobs: &BlobCount) -> Result<()> {
        if self.package_id != package_id {
            return Err(invalid(format!(
                "receipt.packageId {} is not this package ({package_id})",
                self.package_id
            )));
        }
        if self.form != form {
            return Err(invalid(format!(
                "receipt.form is {} but the container is {}",
                self.form.as_str(),
                form.as_str()
            )));
        }
        if &self.embedded_blobs != blobs {
            return Err(invalid(format!(
                "receipt.embeddedBlobs is {}/{} but the container holds {}/{}",
                self.embedded_blobs.count, self.embedded_blobs.bytes, blobs.count, blobs.bytes
            )));
        }
        Ok(())
    }
}
