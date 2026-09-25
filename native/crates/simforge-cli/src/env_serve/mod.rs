//! `simforge env serve`: closed-loop episodes over a Unix socket
//! (`simforge.env-serve/v1`, see [`wire`]).

pub mod frames;
pub mod sensors;
pub mod server;
pub mod wire;
