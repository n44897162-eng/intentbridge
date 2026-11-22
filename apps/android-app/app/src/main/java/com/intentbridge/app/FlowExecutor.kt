package com.intentbridge.app

import android.content.Context
import android.os.SystemClock
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

interface DecisionProvider {
    suspend fun approve(summary: JSONObject): Boolean
    suspend fun disambiguate(candidates: JSONArray): String?
    suspend fun outcome(error: JSONObject): String
    suspend fun recover(reason: String, options: List<String>): String
}

/**
 * Drives the Rust engine over JNI. One loop, one state machine; the provider
 * only observes and acts on the current accessibility tree.
 */
class FlowExecutor(private val context: Context) {
    data class Result(val status: String, val state: String, val error: JSONObject?)

    suspend fun run(
        flowJson: String,
        variables: Map<String, String>,
        runId: String,
        repository: FlowRepository,
        decisions: DecisionProvider? = null,
    ): Result {
        val service = IntentBridgeAccessibilityService.instance
            ?: return Result("failed", "FAILED", JSONObject().put("code", "UNSUPPORTED_CAPABILITY").put("message", "accessibility service is off"))
        val engine = NativeEngine()
        val flow = JSONObject(flowJson)
        val expectedPackage = flow.getJSONObject("app_scope").getString("value")
        val startedMono = SystemClock.elapsedRealtime().toDouble()
        val startedWall = System.currentTimeMillis()
        val secrets = SecretStore(context)
        var lastSeq = 0
        var output: JSONObject

        suspend fun submit(input: JSONObject): JSONObject {
            val now = SystemClock.elapsedRealtime().toDouble() - startedMono
            input.put("now_mono_ms", now)
            val response = JSONObject(engine.command(JSONObject().put("cmd", "submit").put("input", input).toString()))
            val result = response.optJSONObject("result") ?: JSONObject()
            val events = result.optJSONArray("events")
            if (events != null) {
                for (i in 0 until events.length()) {
                    val event = events.getJSONObject(i)
                    val seq = event.optInt("seq", lastSeq + 1)
                    if (seq > lastSeq) {
                        repository.appendEvent(runId, seq, event.toString())
                        lastSeq = seq
                    }
                }
            }
            return result
        }

        fun facts(): JSONObject {
            val snapshot = service.snapshot()
            val now = SystemClock.elapsedRealtime().toDouble() - startedMono
            return JSONObject().apply {
                put("now_mono_ms", now)
                put("app_scope", snapshot?.packageName ?: service.currentPackage() ?: "")
                put("url", snapshot?.packageName ?: "")
                put("window_title", snapshot?.windowTitle ?: "")
                put("window_stable_ms", maxOf(0, System.currentTimeMillis() - service.lastStructureChange))
                put("elements", snapshot?.candidates ?: JSONArray())
            }
        }

        try {
            val load = JSONObject(engine.command(JSONObject().put("cmd", "load_json").put("json", flowJson).toString()))
            if (!load.optBoolean("ok")) return fail(repository, runId, load.optJSONObject("error"))
            val validate = JSONObject(engine.command(JSONObject().put("cmd", "validate").toString()))
            if (!validate.optBoolean("ok")) return fail(repository, runId, validate.optJSONObject("error"))
            engine.command(JSONObject().put("cmd", "arm").toString())
            output = JSONObject(
                engine.command(
                    JSONObject().put("cmd", "start")
                        .put("run_id", runId)
                        .put("now_mono_ms", 0)
                        .put("wall_time_ms", startedWall)
                        .put("variables", JSONObject(variables as Map<*, *>))
                        .toString(),
                ),
            ).optJSONObject("result") ?: JSONObject()

            repeat(500) {
                val snapshot = service.snapshot()
                when (output.optString("kind")) {
                    "Finished" -> {
                        val status = output.optString("status")
                        repository.updateRun(runId, status.ifEmpty { "failed" }, output.optString("state"), output.optJSONObject("error")?.toString())
                        return Result(status.ifEmpty { "failed" }, output.optString("state"), output.optJSONObject("error"))
                    }
                    "ResolveTarget" -> {
                        val input = JSONObject().apply {
                            put("kind", "Candidates")
                            put("step_id", output.getString("step_id"))
                            put("attempt_id", output.getString("attempt_id"))
                            put("candidates", snapshot?.candidates ?: JSONArray())
                            put("facts", facts())
                        }
                        output = submit(input)
                    }
                    "PerformAction" -> {
                        val action = output.getString("action")
                        val candidateId = output.optJSONObject("resolved")?.optString("candidate_id")
                        val node = candidateId?.let { snapshot?.nodes?.get(it) }
                        val params = output.optJSONObject("params") ?: JSONObject()
                        val activePackage = service.currentPackage()
                        if (action != "launch" && expectedPackage != activePackage) {
                            output = submit(JSONObject().apply {
                                put("kind", "ActionDone")
                                put("step_id", output.getString("step_id"))
                                put("attempt_id", output.getString("attempt_id"))
                                put("outcome", "failed")
                                put("error", JSONObject().put("code", "APP_SCOPE_VIOLATION").put("message", "left $expectedPackage"))
                            })
                        } else {
                            var error: JSONObject? = null
                            var text: String? = null
                            when (action) {
                                "launch" -> {
                                    val intent = context.packageManager.getLaunchIntentForPackage(expectedPackage)
                                    if (intent == null) error = JSONObject().put("code", "UNSUPPORTED_CAPABILITY").put("message", "no launcher")
                                    else {
                                        context.startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                                        var waited = 0
                                        while (service.currentPackage() != expectedPackage && waited < 20_000) {
                                            delay(120)
                                            waited += 120
                                        }
                                    }
                                }
                                "click" -> if (node == null || !service.performClick(node)) {
                                    error = JSONObject().put("code", "STALE_TARGET").put("message", "node unavailable")
                                }
                                "input" -> {
                                    val raw = params.optString("value")
                                    val value = if (raw.startsWith("secret://")) secrets.get(raw.removePrefix("secret://")) else raw
                                    if (value == null) error = JSONObject().put("code", "SECRET_NOT_FOUND").put("message", "secret missing")
                                    else if (node == null || !service.setText(node, value)) {
                                        error = JSONObject().put("code", "STALE_TARGET").put("message", "node unavailable")
                                    }
                                }
                                "scroll" -> {
                                    val node2 = node?.parent
                                    if (node2 == null || !service.scroll(node2, params.optString("direction", "down") == "down")) {
                                        error = JSONObject().put("code", "STALE_TARGET").put("message", "scroll failed")
                                    }
                                }
                                "read-text" -> text = node?.text?.toString()
                                "activate" -> Unit
                                else -> error = JSONObject().put("code", "UNSUPPORTED_CAPABILITY").put("message", "action $action")
                            }
                            val input = JSONObject().apply {
                                put("kind", "ActionDone")
                                put("step_id", output.getString("step_id"))
                                put("attempt_id", output.getString("attempt_id"))
                                put("outcome", if (error == null) "succeeded" else "failed")
                                if (error != null) put("error", error)
                                if (text != null) put("text", text)
                                put("facts", facts())
                            }
                            output = submit(input)
                        }
                    }
                    "AwaitCondition" -> {
                        output = submit(JSONObject().apply {
                            put("kind", "Observation")
                            put("step_id", output.getString("step_id"))
                            put("attempt_id", output.optString("attempt_id"))
                            put("condition_id", output.getString("condition_id"))
                            put("facts", facts())
                        })
                    }
                    "AwaitTimer" -> {
                        val now = SystemClock.elapsedRealtime().toDouble() - startedMono
                        val wait = (output.optDouble("wake_at_mono_ms", now) - now).toLong().coerceAtLeast(0)
                        delay(wait)
                        output = submit(JSONObject().put("kind", "Tick"))
                    }
                    "AwaitApproval" -> {
                        val provider = decisions ?: return paused(repository, runId, output)
                        val approved = provider.approve(output.optJSONObject("summary") ?: JSONObject())
                        output = submit(JSONObject().apply {
                            put("kind", "Approval")
                            put("step_id", output.getString("step_id"))
                            put("attempt_id", output.getString("attempt_id"))
                            put("approved", approved)
                        })
                    }
                    "AwaitDisambiguation" -> {
                        val provider = decisions ?: return paused(repository, runId, output)
                        val choice = provider.disambiguate(output.optJSONArray("candidates") ?: JSONArray())
                            ?: return paused(repository, runId, output)
                        output = submit(JSONObject().apply {
                            put("kind", "Disambiguation")
                            put("step_id", output.getString("step_id"))
                            put("attempt_id", output.getString("attempt_id"))
                            put("candidate_id", choice)
                        })
                    }
                    "AwaitOutcomeDecision" -> {
                        val provider = decisions ?: return paused(repository, runId, output)
                        val decision = provider.outcome(output.optJSONObject("error") ?: JSONObject())
                        output = submit(JSONObject().apply {
                            put("kind", "OutcomeDecision")
                            put("step_id", output.getString("step_id"))
                            put("attempt_id", output.getString("attempt_id"))
                            put("decision", decision)
                        })
                    }
                    "AwaitRecovery" -> {
                        val provider = decisions ?: return paused(repository, runId, output)
                        val options = output.optJSONArray("options")?.let { array ->
                            (0 until array.length()).map { index -> array.getString(index) }
                        } ?: emptyList()
                        val decision = provider.recover(output.optString("reason"), options)
                        output = submit(JSONObject().put("kind", "RecoveryDecision").put("decision", decision))
                    }
                    else -> return Result("failed", "FAILED", JSONObject().put("code", "INTERNAL_ERROR").put("message", "unexpected directive ${output.optString("kind")}"))
                }
            }
            return Result("paused", "PAUSED_FOR_RECOVERY", JSONObject().put("code", "RUNTIME_LIMIT_EXCEEDED").put("message", "step loop cap"))
        } catch (error: Exception) {
            val payload = JSONObject().put("code", "INTERNAL_ERROR").put("message", error.message ?: "executor failure")
            repository.updateRun(runId, "failed", "FAILED", payload.toString())
            return Result("failed", "FAILED", payload)
        } finally {
            engine.close()
        }
    }

    private fun paused(repository: FlowRepository, runId: String, directive: JSONObject): Result {
        repository.updateRun(runId, "paused", "PAUSED", null)
        return Result("paused", "PAUSED", null)
    }

    private fun fail(repository: FlowRepository, runId: String, error: JSONObject?): Result {
        val code = error?.optString("code") ?: "INVALID_IR"
        repository.updateRun(runId, "failed", "FAILED", error?.toString())
        return Result("failed", "FAILED", JSONObject().put("code", code))
    }
}
