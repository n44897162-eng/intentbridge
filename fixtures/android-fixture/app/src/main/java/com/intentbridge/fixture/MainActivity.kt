package com.intentbridge.fixture

import android.app.AlertDialog
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Controllable Android fixture. Variants change labels, order and duplicate
 * controls; resource ids stay stable unless the `renamed` layout variant is
 * used (documented in the README as a known limitation).
 */
class MainActivity : AppCompatActivity() {
    private val catalog = listOf(
        "Alpha 季度报告 · 收入与留存",
        "Beta 客户画像 · 生命周期",
        "Gamma 运营周报 · 转化漏斗",
        "Delta 数据质量 · 缺失值监控",
        "Epsilon 摘要 · 管理层季报",
    )
    private lateinit var keyword: EditText
    private lateinit var summary: TextView
    private lateinit var results: ListView
    private var variant: String = "baseline"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        variant = intent.getStringExtra("variant") ?: "baseline"
        keyword = findViewById(R.id.keyword)
        summary = findViewById(R.id.summary)
        results = findViewById(R.id.results)
        results.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, mutableListOf<String>())
        findViewById<TextView>(R.id.variant).text = "variant: $variant"
        findViewById<Button>(R.id.search).setOnClickListener { search() }
        findViewById<Button>(R.id.open_detail).setOnClickListener { showDetail() }
        findViewById<Button>(R.id.recreate).setOnClickListener { recreate() }
        applyVariant()
    }

    private fun applyVariant() {
        val form = findViewById<LinearLayout>(R.id.form)
        when (variant) {
            "moved" -> {
                val page = findViewById<LinearLayout>(R.id.page)
                page.removeView(form)
                page.addView(form)
            }
            "decoy" -> findViewById<Button>(R.id.ghost).visibility = View.VISIBLE
            "renamed" -> {
                keyword.hint = "请输入查询词"
                keyword.contentDescription = "查询"
                val search = findViewById<Button>(R.id.search)
                search.text = "查询"
                search.contentDescription = "查询"
            }
        }
    }

    private fun search() {
        val query = keyword.text.toString().trim()
        if (query.isEmpty()) {
            summary.text = "请输入关键词后再搜索"
            (results.adapter as ArrayAdapter<String>).clear()
            return
        }
        val matches = catalog.filter { it.contains(query, ignoreCase = true) }.ifEmpty { listOf("关于“$query”的结果") }
        val adapter = results.adapter as ArrayAdapter<String>
        adapter.clear()
        adapter.addAll(matches)
        adapter.notifyDataSetChanged()
        summary.text = "找到 ${matches.size} 条与“$query”相关的结果"
    }

    private fun showDetail() {
        val item = results.selectedItem?.toString() ?: summary.text.toString()
        AlertDialog.Builder(this)
            .setTitle("报告详情")
            .setMessage(item)
            .setPositiveButton("关闭", null)
            .show()
    }
}
