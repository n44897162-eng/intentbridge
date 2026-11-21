package com.intentbridge.app

import android.app.Activity
import android.app.AlertDialog
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** Human decisions are always explicit; nothing is auto-approved by default. */
class DialogDecisionProvider(private val activity: Activity) : DecisionProvider {
    override suspend fun approve(summary: JSONObject): Boolean = ask(
        "批准高风险步骤",
        "动作：${summary.optString("action")}\n风险：${summary.optString("risk")}\n目标：${summary.optString("target_label")}",
        "批准",
        "拒绝",
    )

    override suspend fun disambiguate(candidates: JSONArray): String? {
        val labels = (0 until candidates.length()).map { index ->
            val candidate = candidates.getJSONObject(index).optJSONObject("candidate")
            val semantic = candidate?.optJSONObject("semantic")
            "${semantic?.optString("name")?.ifEmpty { semantic.optString("test_id") } ?: "候选 $index"} (${"%.2f".format(candidates.getJSONObject(index).optDouble("total"))})"
        }.toTypedArray()
        val deferred = CompletableDeferred<String?>()
        withContext(Dispatchers.Main) {
            AlertDialog.Builder(activity)
                .setTitle("需要确认目标")
                .setItems(labels) { _, which -> deferred.complete(candidates.getJSONObject(which).optJSONObject("candidate")?.optString("candidate_id")) }
                .setOnCancelListener { deferred.complete(null) }
                .show()
        }
        return deferred.await()
    }

    override suspend fun outcome(error: JSONObject): String {
        val deferred = CompletableDeferred<String>()
        withContext(Dispatchers.Main) {
            AlertDialog.Builder(activity)
                .setTitle("外部副作用未知")
                .setMessage("${error.optString("code")}: ${error.optString("message")}\n请确认上一步是否已生效。")
                .setPositiveButton("确认已成功") { _, _ -> deferred.complete("succeeded") }
                .setNegativeButton("确认未成功") { _, _ -> deferred.complete("failed") }
                .setNeutralButton("重试") { _, _ -> deferred.complete("retry") }
                .setOnCancelListener { deferred.complete("failed") }
                .show()
        }
        return deferred.await()
    }

    override suspend fun recover(reason: String, options: List<String>): String {
        val deferred = CompletableDeferred<String>()
        withContext(Dispatchers.Main) {
            AlertDialog.Builder(activity)
                .setTitle("运行已暂停")
                .setMessage(reason)
                .setItems(options.toTypedArray()) { _, which -> deferred.complete(options[which]) }
                .setOnCancelListener { deferred.complete("stop") }
                .show()
        }
        return deferred.await()
    }

    private suspend fun ask(title: String, message: String, positive: String, negative: String): Boolean {
        val deferred = CompletableDeferred<Boolean>()
        withContext(Dispatchers.Main) {
            AlertDialog.Builder(activity)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton(positive) { _, _ -> deferred.complete(true) }
                .setNegativeButton(negative) { _, _ -> deferred.complete(false) }
                .setOnCancelListener { deferred.complete(false) }
                .show()
        }
        return deferred.await()
    }
}
