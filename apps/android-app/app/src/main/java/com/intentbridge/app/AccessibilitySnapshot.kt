package com.intentbridge.app

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Builds the platform-neutral candidate list the engine consumes. Values of
 * password fields are never emitted, and node text is bounded.
 */
object AccessibilitySnapshot {
    private const val MAX_NODES = 400
    private const val MAX_DEPTH = 14

    data class Snapshot(
        val candidates: JSONArray,
        val nodes: Map<String, AccessibilityNodeInfo>,
        val packageName: String,
        val windowTitle: String,
    )

    fun capture(root: AccessibilityNodeInfo, displayWidth: Int, displayHeight: Int): Snapshot {
        val candidates = JSONArray()
        val nodes = HashMap<String, AccessibilityNodeInfo>()
        val packageName = root.packageName?.toString().orEmpty()
        val windowTitle = root.window?.title?.toString().orEmpty()
        val path = ArrayList<String>()
        walk(root, path, candidates, nodes, displayWidth, displayHeight, packageName, windowTitle, 0)
        return Snapshot(candidates, nodes, packageName, windowTitle)
    }

    private fun walk(
        node: AccessibilityNodeInfo,
        path: MutableList<String>,
        out: JSONArray,
        nodes: MutableMap<String, AccessibilityNodeInfo>,
        width: Int,
        height: Int,
        packageName: String,
        windowTitle: String,
        depth: Int,
    ) {
        if (out.length() >= MAX_NODES || depth > MAX_DEPTH) return
        if (node.isVisibleToUser) {
            val candidate = describe(node, path, width, height, packageName, windowTitle)
            if (candidate != null) {
                out.put(candidate)
                nodes[candidate.getString("candidate_id")] = node
            }
        }
        val token = tokenOf(node, path)
        if (token != null) path.add(token)
        for (index in 0 until minOf(node.childCount, 120)) {
            val child = node.getChild(index) ?: continue
            walk(child, path, out, nodes, width, height, packageName, windowTitle, depth + 1)
        }
        if (token != null) path.removeAt(path.size - 1)
    }

    private fun roleOf(node: AccessibilityNodeInfo): String =
        when (node.className?.toString()?.substringAfterLast('.')?.lowercase()) {
            "button", "imagebutton", "materialbutton" -> "button"
            "edittext", "autocompletetextview", "textinputedittext" -> "textbox"
            "textview" -> "text"
            "checkbox", "switch", "togglebutton" -> "checkbox"
            "radiobutton" -> "radio"
            "listview", "recyclerview", "gridview" -> "list"
            "imageview" -> "img"
            else -> "generic"
        }

    private fun tokenOf(node: AccessibilityNodeInfo, parents: List<String>): String? {
        val className = node.className?.toString()?.substringAfterLast('.')?.lowercase() ?: return null
        val resourceId = node.viewIdResourceName?.substringAfterLast('/') ?: ""
        if (resourceId.isNotEmpty()) return "$className#$resourceId"
        val text = node.text?.toString()?.take(24)?.replace(Regex("[^\\p{L}\\p{N}]+"), "-")
        if (!text.isNullOrEmpty()) return "$className[$text]"
        val parent = node.parent ?: return className
        val index = (0 until parent.childCount).count { parent.getChild(it)?.className == node.className }
        return if (index > 1) "$className:nth-of-type($index)" else className
    }

    private fun describe(
        node: AccessibilityNodeInfo,
        parents: List<String>,
        width: Int,
        height: Int,
        packageName: String,
        windowTitle: String,
    ): JSONObject? {
        if (node.isPassword) {
            // Never emit text/value for password fields; anchors remain usable.
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            val candidateId = idFor(parents, node, bounds)
            return JSONObject().apply {
                put("candidate_id", candidateId)
                put("native_identity", JSONObject().put("kind", "android-resource-id").put("value", node.viewIdResourceName ?: ""))
                put("semantic", JSONObject().put("role", roleOf(node)).put("control_type", node.className?.toString() ?: "").put("test_id", node.viewIdResourceName ?: ""))
                put("context", JSONObject().put("app_scope", packageName).put("window_title", windowTitle))
                put("visible", true)
                put("enabled", node.isEnabled)
                put("editable", node.isEditable)
                put("text", JSONObject.NULL)
            }
        }
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        val candidateId = idFor(parents, node, bounds)
        val semantic = JSONObject().apply {
            put("role", roleOf(node))
            put("control_type", node.className?.toString() ?: "")
            node.contentDescription?.toString()?.let { put("name", it) }
            node.text?.toString()?.take(120)?.let { put("text", it) }
            node.viewIdResourceName?.let {
                put("test_id", it)
                if (!has("name")) put("name", it.substringAfterLast('/'))
            }
        }
        val structure = JSONObject().apply {
            put("path", JSONArray(parents.takeLast(6)))
            if (parents.isNotEmpty()) put("parent", parents.last())
        }
        val visual = JSONObject().apply {
            put("norm_rect", JSONObject().apply {
                put("x", (bounds.left.toDouble() / width).coerceIn(0.0, 1.0))
                put("y", (bounds.top.toDouble() / height).coerceIn(0.0, 1.0))
                put("w", (bounds.width().toDouble() / width).coerceIn(0.0, 1.0))
                put("h", (bounds.height().toDouble() / height).coerceIn(0.0, 1.0))
            })
            put("viewport", JSONObject().put("w", width).put("h", height))
        }
        return JSONObject().apply {
            put("candidate_id", candidateId)
            node.viewIdResourceName?.let {
                put("native_identity", JSONObject().put("kind", "android-resource-id").put("value", it))
            }
            put("semantic", semantic)
            put("structure", structure)
            put("visual", visual)
            put("context", JSONObject().put("app_scope", packageName).put("window_title", windowTitle))
            put("visible", true)
            put("enabled", node.isEnabled)
            put("editable", node.isEditable)
            put("in_viewport", true)
            put("rect", JSONObject().apply {
                put("x", bounds.left); put("y", bounds.top); put("w", bounds.width()); put("h", bounds.height())
            })
            node.text?.toString()?.take(1000)?.let { put("text", it) }
        }
    }

    private fun idFor(parents: List<String>, node: AccessibilityNodeInfo, bounds: Rect): String {
        val raw = "${parents.joinToString(">")}|${node.className}|${node.viewIdResourceName}|${bounds.toShortString()}"
        val hash = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray()).take(8)
        return "a-" + hash.joinToString("") { "%02x".format(it) }
    }
}
