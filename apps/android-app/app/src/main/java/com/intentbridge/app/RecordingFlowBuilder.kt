package com.intentbridge.app

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Converts recorded accessibility observations into a draft Action IR flow. */
object RecordingFlowBuilder {
    fun build(events: JSONArray, packageName: String, name: String): String {
        val steps = JSONArray()
        steps.put(JSONObject().apply {
            put("id", "launch")
            put("action", "launch")
            put("name", "启动应用")
            put("risk", "normal")
            put("postconditions", JSONArray().put(JSONObject().put("kind", "window-stable").put("min_stable_ms", 150)))
            put("params", JSONObject().put("app_id", packageName).put("wait_ready", true))
        })
        var index = 0
        for (i in 0 until events.length()) {
            val event = events.getJSONObject(i)
            if (event.optBoolean("password")) continue
            index++
            val candidate = event.getJSONObject("candidate")
            val action = if (event.optString("type") == "input") "input" else "click"
            val step = JSONObject().apply {
                put("id", "step-$index")
                put("action", action)
                put("name", (if (action == "input") "输入：" else "点击：") +
                    (candidate.optJSONObject("semantic")?.optString("name") ?: candidate.optString("candidate_id")))
                put("target", JSONObject().put("anchors", anchors(candidate)))
                put("risk", "normal")
                put("timeout_ms", 30000)
                put("postconditions", JSONArray().put(JSONObject().put("kind", "window-stable").put("min_stable_ms", 250)))
                put("params", if (action == "input") JSONObject().put("value", event.optString("value")).put("clear_first", true) else JSONObject().put("button", "left"))
            }
            steps.put(step)
        }
        steps.put(JSONObject().apply { put("id", "done"); put("action", "end"); put("params", JSONObject().put("status", "success")) })
        return JSONObject().apply {
            put("schema_version", "1.0.0")
            put("flow_id", UUID.randomUUID().toString())
            put("name", name)
            put("platform", "android")
            put("app_scope", JSONObject().put("kind", "android-package").put("value", packageName))
            put("variables", JSONArray())
            put("permissions", JSONArray(listOf("read-ui", "read-screen", "click", "type", "launch")))
            put("steps", steps)
            put("created_by", "android-recorder")
            put("revision", 1)
        }.toString(2)
    }

    private fun anchors(candidate: JSONObject): JSONObject {
        val anchors = JSONObject()
        candidate.optJSONObject("semantic")?.let { anchors.put("semantic", it) }
        candidate.optJSONObject("native_identity")?.let { anchors.put("native_identity", it) }
        candidate.optJSONObject("structure")?.let {
            anchors.put("structure", JSONObject().put("path", it.optJSONArray("path") ?: JSONArray()))
        }
        candidate.optJSONObject("visual")?.let { anchors.put("visual", it) }
        return anchors
    }

    fun validate(flowJson: String): String? {
        val engine = NativeEngine()
        return try {
            val load = JSONObject(engine.command(JSONObject().put("cmd", "load_json").put("json", flowJson).toString()))
            if (!load.optBoolean("ok")) return load.optJSONObject("error")?.optJSONObject("detail")?.toString() ?: "INVALID_IR"
            val validate = JSONObject(engine.command(JSONObject().put("cmd", "validate").toString()))
            if (!validate.optBoolean("ok")) validate.optJSONObject("error")?.optJSONObject("detail")?.toString() ?: "INVALID_IR" else null
        } finally {
            engine.close()
        }
    }
}
