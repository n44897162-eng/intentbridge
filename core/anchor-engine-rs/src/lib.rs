//! IntentBridge anchor engine.
//!
//! Pure candidate scoring for semantic, structural, native and visual anchors.
//! It never touches the OS, never runs a model, and always records the evidence
//! behind a ranking so a human can audit why a target was chosen.

pub mod score;
pub mod types;

pub use score::rank;
pub use types::*;
