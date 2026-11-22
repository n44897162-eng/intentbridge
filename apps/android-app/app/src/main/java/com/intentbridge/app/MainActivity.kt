package com.intentbridge.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var repository: FlowRepository
    private lateinit var status: TextView
    private lateinit var flows: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repository = FlowRepository(this)
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        if (intent.getBooleanExtra("stop_recording", false)) stopRecording()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 36, 36, 36)
        }
        root.addView(TextView(this).apply {
            text = "IntentBridge"
            textSize = 26f
        })
        status = TextView(this).apply {
            text = statusText()
            setPadding(0, 12, 0, 20)
        }
        root.addView(status)
        root.addView(button("打开无障碍设置") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })
        root.addView(button("开始录制") {
            val service = IntentBridgeAccessibilityService.instance
            if (service == null) {
                status.text = "请先在系统设置中启用 IntentBridge 无障碍服务"
            } else if (service.startRecording()) {
                status.text = statusText()
            }
        })
        root.addView(button("停止并保存") {
            stopRecording()
        })
        root.addView(button("每日 09:00 定时首个流程（WorkManager，受厂商后台限制）") {
            val first = repository.listFlows().firstOrNull()
            if (first == null) {
                status.text = "还没有流程"
            } else {
                val request = PeriodicWorkRequestBuilder<ScheduledFlowWorker>(1, TimeUnit.DAYS)
                    .setInitialDelay(1, TimeUnit.HOURS)
                    .setInputData(androidx.work.Data.Builder().putString("flow_id", first.first).build())
                    .build()
                WorkManager.getInstance(this).enqueueUniquePeriodicWork(
                    "intentbridge-${first.first}",
                    ExistingPeriodicWorkPolicy.UPDATE,
                    request,
                )
                status.text = "已排入 WorkManager；系统可能延迟或限制后台执行"
            }
        })
        root.addView(TextView(this).apply {
            text = "流程"
            textSize = 18f
            setPadding(0, 28, 0, 10)
        })
        flows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(flows, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setContentView(ScrollView(this).apply { addView(root) })
        refreshFlows()
    }

    override fun onResume() {
        super.onResume()
        status.text = statusText()
    }

    private fun statusText(): String {
        val enabled = IntentBridgeAccessibilityService.instance != null
        return if (enabled) "无障碍服务已启用 · 录制/执行仅在你手动触发时进行" else "无障碍服务未启用"
    }

    private fun button(label: String, action: () -> Unit): Button =
        Button(this).apply {
            text = label
            setOnClickListener { action() }
        }

    private fun stopRecording() {
        val service = IntentBridgeAccessibilityService.instance ?: return
        val events = service.stopRecording()
        if (events.length() == 0) {
            status.text = "没有录制到事件"
            return
        }
        // Use the recorded event's package, not the current foreground app:
        // the user is in IntentBridge's own UI when pressing Stop.
        val packageName = events.optJSONObject(0)?.optString("scope")?.takeIf { it.isNotEmpty() }
            ?: service.currentPackage() ?: return
        val flowJson = RecordingFlowBuilder.build(events, packageName, "Android 录制 ${events.length()} 步")
        val issue = RecordingFlowBuilder.validate(flowJson)
        if (issue != null) {
            status.text = "录制结果未通过校验：$issue"
            return
        }
        repository.saveFlow(flowJson, "Android 录制 ${events.length()} 步", 1)
        status.text = "已保存流程（${events.length()} 个事件）"
        refreshFlows()
    }

    private fun refreshFlows() {
        flows.removeAllViews()
        val stored = repository.listFlows()
        if (stored.isEmpty()) {
            flows.addView(TextView(this).apply { text = "还没有流程。录制一段操作生成草稿。" })
            return
        }
        for ((id, name, json) in stored) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            row.addView(TextView(this).apply {
                text = name
                setPadding(0, 8, 24, 8)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(button("运行") {
                runFlow(id, json)
            })
            flows.addView(row)
        }
    }

    private fun runFlow(flowId: String, flowJson: String) {
        val service = IntentBridgeAccessibilityService.instance
        if (service == null) {
            status.text = "请先启用无障碍服务"
            return
        }
        val runId = "run-${UUID.randomUUID()}"
        repository.createRun(runId, flowId, "manual")
        status.text = "运行中…"
        lifecycleScope.launch {
            val result = withContext(Dispatchers.Default) {
                FlowExecutor(applicationContext).run(
                    flowJson,
                    emptyMap(),
                    runId,
                    repository,
                    DialogDecisionProvider(this@MainActivity),
                )
            }
            status.text = when (result.status) {
                "succeeded" -> "运行成功"
                "paused" -> "运行暂停，等待人工决定"
                else -> "运行失败：${result.error?.optString("code") ?: result.status}"
            }
        }
    }
}
