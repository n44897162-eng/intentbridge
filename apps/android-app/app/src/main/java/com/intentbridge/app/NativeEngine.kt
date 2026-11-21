package com.intentbridge.app

/**
 * Thin JNI bridge to the shared Rust engine. All state-machine semantics live in
 * Rust; this class only shuffles the JSON protocol across the boundary.
 */
class NativeEngine : AutoCloseable {
    private var handle: Long = nativeNew()

    val isValid: Boolean get() = handle != 0L

    fun command(json: String): String {
        check(handle != 0L) { "engine is closed" }
        return nativeCommand(handle, json)
    }

    override fun close() {
        if (handle != 0L) {
            nativeDestroy(handle)
            handle = 0L
        }
    }

    private companion object {
        init {
            System.loadLibrary("ib_runtime")
        }

        @JvmStatic external fun nativeNew(): Long
        @JvmStatic external fun nativeCommand(handle: Long, json: String): String
        @JvmStatic external fun nativeDestroy(handle: Long)
    }
}
