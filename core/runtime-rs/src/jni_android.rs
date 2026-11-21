//! JNI surface used by the Android AccessibilityService host.
//!
//! Only compiled for `target_os = "android"`. The JSON protocol is identical to
//! the C ABI/WASM protocol; no logic is duplicated on the Kotlin side.

use crate::abi;
use crate::engine::Engine;
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;

fn engine_mut<'a>(handle: jlong) -> Option<&'a mut Engine> {
    if handle == 0 {
        None
    } else {
        Some(unsafe { &mut *(handle as *mut Engine) })
    }
}

#[no_mangle]
pub extern "system" fn Java_com_intentbridge_app_NativeEngine_nativeNew(
    _env: JNIEnv,
    _class: JClass,
) -> jlong {
    Box::into_raw(Box::new(Engine::new())) as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_intentbridge_app_NativeEngine_nativeCommand(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    json: JString,
) -> jstring {
    let text: String = match env.get_string(&json) {
        Ok(value) => value.into(),
        Err(_) => return std::ptr::null_mut(),
    };
    let response = match engine_mut(handle) {
        Some(engine) => abi::command_engine(engine, &text),
        None => {
            "{\"ok\":false,\"error\":{\"code\":\"INVALID_STATE\",\"message\":\"closed engine\"}}"
                .to_string()
        }
    };
    match env.new_string(response) {
        Ok(value) => value.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_intentbridge_app_NativeEngine_nativeDestroy(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        unsafe {
            drop(Box::from_raw(handle as *mut Engine));
        }
    }
}
