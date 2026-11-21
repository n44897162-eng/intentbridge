//! IntentBridge deterministic runtime.
//!
//! Compiled natively (Windows/Android hosts via FFI/JNI) and to WASM (browser
//! extension). Platform actions are always delegated through the host.

pub mod abi;
pub mod conditions;
pub mod engine;
pub mod events;
pub mod ir;

#[cfg(target_os = "android")]
pub mod jni_android;

pub use conditions::Facts;
pub use engine::{
    Engine, EngineConfig, EngineInput, EngineState, RecoveredRun, StartOptions, StepOutput,
};
pub use events::RunEvent;
pub use ir::validate_flow;
