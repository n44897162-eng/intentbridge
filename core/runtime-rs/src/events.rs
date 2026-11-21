//! Append-only run events. `seq` is gap-free per run; consumers are idempotent
//! on `(run_id, seq)`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const EVENT_SCHEMA_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunEvent {
    pub schema_version: String,
    pub event_id: String,
    pub run_id: String,
    pub seq: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub ts: String,
    pub mono_ms: f64,
    pub step_id: Option<String>,
    pub attempt_id: Option<String>,
    pub payload: Value,
}

fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub fn event_id(run_id: &str, seq: u64) -> String {
    let a = fnv1a(&format!("{run_id}:{seq}:a"));
    let b = fnv1a(&format!("{run_id}:{seq}:b"));
    format!("evt-{a:016x}{b:016x}")
}

/// Days-to-civil conversion (Howard Hinnant), avoids a chrono dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn iso8601_from_epoch_ms(epoch_ms: i64) -> String {
    let ms = epoch_ms.rem_euclid(86_400_000);
    let days = (epoch_ms - ms) / 86_400_000;
    let (year, month, day) = civil_from_days(days);
    let second_of_day = ms / 1000;
    let millis = ms % 1000;
    let hour = second_of_day / 3600;
    let minute = (second_of_day % 3600) / 60;
    let second = second_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[allow(clippy::too_many_arguments)]
pub fn make_event(
    run_id: &str,
    seq: u64,
    mono_ms: f64,
    wall_ms: i64,
    step_id: Option<&str>,
    attempt_id: Option<&str>,
    event_type: &str,
    payload: Value,
) -> RunEvent {
    RunEvent {
        schema_version: EVENT_SCHEMA_VERSION.to_string(),
        event_id: event_id(run_id, seq),
        run_id: run_id.to_string(),
        seq,
        event_type: event_type.to_string(),
        ts: iso8601_from_epoch_ms(wall_ms),
        mono_ms,
        step_id: step_id.map(|s| s.to_string()),
        attempt_id: attempt_id.map(|s| s.to_string()),
        payload,
    }
}

/// Structural validation used when importing/replaying persisted events.
pub fn validate_event_sequence(events: &[RunEvent], run_id: &str) -> Vec<String> {
    let mut errors = Vec::new();
    let mut expected = 1u64;
    for event in events {
        if event.schema_version != EVENT_SCHEMA_VERSION {
            errors.push(format!("seq {}: schema_version mismatch", event.seq));
        }
        if event.run_id != run_id {
            errors.push(format!("seq {}: run_id mismatch", event.seq));
        }
        if event.seq != expected {
            errors.push(format!("seq {}: expected {}", event.seq, expected));
        }
        if event.event_type.is_empty() {
            errors.push(format!("seq {}: empty type", event.seq));
        }
        expected += 1;
    }
    errors
}

pub fn state_change(
    run_id: &str,
    seq: u64,
    mono_ms: f64,
    wall_ms: i64,
    from: &str,
    to: &str,
) -> RunEvent {
    make_event(
        run_id,
        seq,
        mono_ms,
        wall_ms,
        None,
        None,
        "StateChanged",
        json!({ "from": from, "to": to }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_format_is_stable() {
        assert_eq!(iso8601_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso8601_from_epoch_ms(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
    }

    #[test]
    fn event_ids_are_deterministic() {
        assert_eq!(event_id("run-1", 1), event_id("run-1", 1));
        assert_ne!(event_id("run-1", 1), event_id("run-1", 2));
    }
}
