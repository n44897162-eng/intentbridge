package com.intentbridge.app

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.util.UUID

/**
 * WorkManager entry point for scheduled runs. Android may defer or block
 * background work; the UI states this explicitly and never promises uptime.
 */
class ScheduledFlowWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val flowId = inputData.getString("flow_id") ?: return Result.failure()
        val repository = FlowRepository(applicationContext)
        val flow = repository.listFlows().firstOrNull { it.first == flowId } ?: return Result.failure()
        if (IntentBridgeAccessibilityService.instance == null) {
            repository.updateRun("run-${UUID.randomUUID()}", "outcome_unknown", "OUTCOME_UNKNOWN", "accessibility service unavailable")
            return Result.failure()
        }
        val runId = "run-${UUID.randomUUID()}"
        repository.createRun(runId, flowId, "schedule")
        val result = FlowExecutor(applicationContext).run(flow.third, emptyMap(), runId, repository, null)
        return when (result.status) {
            "succeeded" -> Result.success()
            "paused" -> Result.success()
            else -> Result.retry()
        }
    }
}
