package com.intentbridge.app

import android.accessibilityservice.AccessibilityService
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * User-started accessibility recording/execution. The service never starts
 * itself, never hides, and always shows a persistent notification while active.
 */
class IntentBridgeAccessibilityService : AccessibilityService() {
    var recording: Boolean = false
        private set
    private var recordedEvents = JSONArray()
    var lastStructureChange: Long = System.currentTimeMillis()
        private set

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        createChannel()
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onInterrupt() {
        recording = false
        cancelNotification()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        lastStructureChange = System.currentTimeMillis()
        if (!recording || event == null) return
        val source = event.source ?: return
        try {
            when (event.eventType) {
                AccessibilityEvent.TYPE_VIEW_CLICKED -> record("click", source)
                AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> record("input", source)
                else -> Unit
            }
        } finally {
            @Suppress("DEPRECATION")
            source.recycle()
        }
    }

    private fun record(kind: String, node: AccessibilityNodeInfo) {
        if (node.isPassword) return
        val root = rootInActiveWindow ?: return
        val metrics = resources.displayMetrics
        val snapshot = AccessibilitySnapshot.capture(root, metrics.widthPixels, metrics.heightPixels)
        val bounds = android.graphics.Rect().also { node.getBoundsInScreen(it) }
        val candidates = (0 until snapshot.candidates.length())
            .map { snapshot.candidates.getJSONObject(it) }
        val viewId = node.viewIdResourceName
        val candidate = candidates.firstOrNull { item ->
            viewId != null &&
                item.optJSONObject("native_identity")?.optString("value") == viewId &&
                item.optJSONObject("rect")?.optInt("x") == bounds.left
        } ?: candidates.firstOrNull { item ->
            // Controls without a native id are matched by stable geometry and
            // accessible name/text; this is the common case in Compose/WebView.
            val rect = item.optJSONObject("rect") ?: return@firstOrNull false
            val close =
                kotlin.math.abs(rect.optInt("x") - bounds.left) <= 4 &&
                    kotlin.math.abs(rect.optInt("y") - bounds.top) <= 4 &&
                    kotlin.math.abs(rect.optInt("w") - bounds.width()) <= 8 &&
                    kotlin.math.abs(rect.optInt("h") - bounds.height()) <= 8
            if (!close) return@firstOrNull false
            val name = item.optJSONObject("semantic")?.optString("name").orEmpty()
            val nodeName = node.contentDescription?.toString().orEmpty()
            name.isEmpty() || nodeName.isEmpty() || name == nodeName ||
                name == node.text?.toString().orEmpty()
        } ?: return
        val event = JSONObject().apply {
            put("type", kind)
            put("candidate", candidate)
            put("scope", snapshot.packageName)
            put("at", System.currentTimeMillis())
            if (kind == "input") {
                put("value", node.text?.toString()?.take(1000) ?: "")
            }
        }
        recordedEvents.put(event)
        updateNotification(recordedEvents.length())
    }

    fun startRecording(): Boolean {
        if (recording) return false
        recordedEvents = JSONArray()
        recording = true
        updateNotification(0)
        return true
    }

    fun stopRecording(): JSONArray {
        recording = false
        cancelNotification()
        return recordedEvents
    }

    fun currentPackage(): String? = rootInActiveWindow?.packageName?.toString()

    fun snapshot(): AccessibilitySnapshot.Snapshot? {
        val root = rootInActiveWindow ?: return null
        val metrics = resources.displayMetrics
        return AccessibilitySnapshot.capture(root, metrics.widthPixels, metrics.heightPixels)
    }

    fun performClick(node: AccessibilityNodeInfo): Boolean =
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)

    fun setText(node: AccessibilityNodeInfo, value: String): Boolean {
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    fun scroll(node: AccessibilityNodeInfo, forward: Boolean): Boolean =
        node.performAction(
            if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
        )

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "IntentBridge 录制/执行", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun updateNotification(events: Int) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        val stop = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java).putExtra("stop_recording", true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle(if (recording) "正在录制 IntentBridge 操作" else "IntentBridge 正在执行")
            .setContentText("已记录 $events 个事件 · 可随时停止")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止录制", stop).build())
            .build()
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }

    private fun cancelNotification() {
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }

    companion object {
        const val CHANNEL = "intentbridge-active"
        const val NOTIFICATION_ID = 4127

        @Volatile
        var instance: IntentBridgeAccessibilityService? = null
    }
}
