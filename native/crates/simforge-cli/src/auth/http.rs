//! The HTTP calls the sign-in protocol makes: every status is an answer to
//! read (OAuth errors arrive as 400 with a JSON body), and no redirect is
//! followed, so a token request can never be re-sent to another place.

use std::io::Read;
use std::time::Duration;

/// Largest body read from an auth endpoint.
const MAX_BODY: u64 = 1024 * 1024;

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent(concat!("simforge/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn read(response: ureq::http::Response<ureq::Body>) -> Result<Reply, String> {
    let status = response.status().as_u16();
    let mut body = Vec::new();
    response
        .into_body()
        .into_reader()
        .take(MAX_BODY)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    Ok(Reply { status, body })
}

/// GET `url`, with `Authorization: Bearer` when a token is given.
pub fn get(url: &str, bearer: Option<&str>, timeout: Duration) -> Result<Reply, String> {
    let mut request = agent(timeout).get(url).header("Accept", "application/json");
    if let Some(token) = bearer {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    read(request.call().map_err(|e| e.to_string())?)
}

/// POST an `application/x-www-form-urlencoded` body (RFC 6749 section 3.2).
pub fn post_form(url: &str, form: &[(&str, &str)], timeout: Duration) -> Result<Reply, String> {
    let response = agent(timeout)
        .post(url)
        .header("Accept", "application/json")
        .send_form(form.iter().copied())
        .map_err(|e| e.to_string())?;
    read(response)
}
