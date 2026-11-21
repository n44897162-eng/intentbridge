//! Minimal C ABI / WASM ABI. JSON in, JSON out; no OS access.
#![allow(clippy::not_unsafe_ptr_arg_deref, clippy::large_enum_variant)]

use crate::engine::{Engine, EngineConfig, EngineInput, StartOptions};
use crate::ir::ValidationIssue;
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::c_void;
use std::sync::Mutex;

static RESPONSE: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    Load {
        flow: Value,
    },
    LoadJson {
        #[serde(rename = "json")]
        json_text: String,
    },
    Validate,
    Arm,
    Start {
        run_id: String,
        now_mono_ms: f64,
        wall_time_ms: i64,
        #[serde(default)]
        variables: std::collections::BTreeMap<String, Value>,
        #[serde(default)]
        start_step_id: Option<String>,
        #[serde(default)]
        single_step: bool,
    },
    Submit {
        input: EngineInput,
    },
    Snapshot,
    Events,
    State,
    Config {
        config: EngineConfig,
    },
    Reset,
}

fn issues_json(issues: &[ValidationIssue]) -> Value {
    json!({ "issues": issues })
}

fn handle(engine: &mut Engine, text: &str) -> Value {
    let command: Command = match serde_json::from_str(text) {
        Ok(command) => command,
        Err(error) => {
            return json!({
                "ok": false,
                "error": { "code": "INVALID_IR", "message": "malformed engine command", "detail": { "parse_error": error.to_string() } }
            })
        }
    };
    let result: Result<Value, crate::engine::BridgeError> = match command {
        Command::Load { flow } => match serde_json::from_value::<crate::ir::Flow>(flow) {
            Ok(flow) => engine.load_value(flow).map(|issues| issues_json(&issues)),
            Err(error) => Err(crate::engine::BridgeError::new(
                "INVALID_IR",
                "flow is not structurally valid",
            )
            .with_detail(json!({ "parse_error": error.to_string() }))),
        },
        Command::LoadJson { json_text } => engine
            .load_json(&json_text)
            .map(|issues| issues_json(&issues)),
        Command::Validate => engine.validate().map(|issues| issues_json(&issues)),
        Command::Arm => engine
            .arm()
            .map(|_| json!({ "state": engine.state().as_str() })),
        Command::Start {
            run_id,
            now_mono_ms,
            wall_time_ms,
            variables,
            start_step_id,
            single_step,
        } => engine
            .start(StartOptions {
                run_id,
                now_mono_ms,
                wall_time_ms,
                variables,
                start_step_id,
                single_step,
            })
            .map(|output| output.to_value()),
        Command::Submit { input } => engine.submit(input).map(|output| output.to_value()),
        Command::Snapshot => Ok(engine.snapshot()),
        Command::Events => Ok(json!({ "events": engine.events() })),
        Command::State => Ok(json!({ "state": engine.state().as_str() })),
        Command::Config { config } => {
            *engine = Engine::with_config(config);
            Ok(json!({ "state": "DRAFT" }))
        }
        Command::Reset => {
            engine.reset_run();
            Ok(json!({ "state": engine.state().as_str() }))
        }
    };
    match result {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn set_response(value: Value) -> usize {
    let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    // The host must copy the bytes before the next call.
    let mut guard = RESPONSE.lock().unwrap();
    *guard = bytes;
    guard.len()
}

#[no_mangle]
pub extern "C" fn ib_alloc(size: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(size);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub extern "C" fn ib_free(pointer: *mut u8, size: usize) {
    if pointer.is_null() {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(pointer, 0, size));
    }
}

#[no_mangle]
pub extern "C" fn ib_new() -> *mut Engine {
    Box::into_raw(Box::new(Engine::new()))
}

#[no_mangle]
pub extern "C" fn ib_destroy(engine: *mut Engine) {
    if engine.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(engine));
    }
}

#[no_mangle]
pub extern "C" fn ib_response_ptr() -> *const u8 {
    let guard = RESPONSE.lock().unwrap();
    guard.as_ptr()
}

#[no_mangle]
pub extern "C" fn ib_response_len() -> usize {
    let guard = RESPONSE.lock().unwrap();
    guard.len()
}

/// Executes one command; returns the response length. The response bytes stay
/// valid until the next call. An empty command returns a no-op error.
#[no_mangle]
pub extern "C" fn ib_cmd(engine: *mut Engine, pointer: *const u8, length: usize) -> usize {
    if engine.is_null() || pointer.is_null() {
        return set_response(
            json!({ "ok": false, "error": { "code": "INVALID_STATE", "message": "null engine or payload" } }),
        );
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            return set_response(
                json!({ "ok": false, "error": { "code": "INVALID_IR", "message": "command is not UTF-8" } }),
            );
        }
    };
    let engine = unsafe { &mut *engine };
    set_response(handle(engine, text))
}

/// Convenience for native hosts that prefer opaque pointers between calls.
#[no_mangle]
pub extern "C" fn ib_command_json(
    engine: *mut Engine,
    pointer: *const u8,
    length: usize,
) -> *mut c_void {
    let _size = ib_cmd(engine, pointer, length);
    let mut guard = RESPONSE.lock().unwrap();
    guard.as_mut_ptr() as *mut c_void
}

/// Executes one command and returns the JSON response string. Shared by JNI.
pub fn command_engine(engine: &mut Engine, text: &str) -> String {
    serde_json::to_string(&handle(engine, text)).unwrap_or_else(|_| {
        "{\"ok\":false,\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"serialization failed\"}}".to_string()
    })
}

/// Runs a command on a fresh engine; used by tests and one-shot native tools.
pub fn command_once(text: &str) -> Value {
    let mut engine = Engine::new();
    handle(&mut engine, text)
}
