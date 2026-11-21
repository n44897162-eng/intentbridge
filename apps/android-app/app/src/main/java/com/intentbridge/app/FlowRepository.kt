package com.intentbridge.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** Local flows and append-only run events (SQLite). */
class FlowRepository(context: Context) : SQLiteOpenHelper(context, "intentbridge.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE flows(id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE runs(id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, status TEXT NOT NULL, state TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER)")
        db.execSQL("CREATE TABLE run_events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(run_id, seq))")
        db.execSQL("CREATE TABLE schedules(id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, rrule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // v1 is the initial schema; future versions add explicit migrations here.
    }

    fun saveFlow(json: String, name: String, revision: Int) {
        val values = ContentValues().apply {
            put("id", Regex("\"flow_id\"\\s*:\\s*\"([^\"]+)\"").find(json)?.groupValues?.get(1) ?: "flow-${System.currentTimeMillis()}")
            put("name", name)
            put("json", json)
            put("revision", revision)
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict("flows", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun listFlows(): List<Triple<String, String, String>> {
        val output = mutableListOf<Triple<String, String, String>>()
        readableDatabase.query("flows", arrayOf("id", "name", "json"), null, null, null, null, "updated_at DESC").use { cursor ->
            while (cursor.moveToNext()) output.add(Triple(cursor.getString(0), cursor.getString(1), cursor.getString(2)))
        }
        return output
    }

    fun createRun(runId: String, flowId: String, trigger: String) {
        writableDatabase.insertOrThrow("runs", null, ContentValues().apply {
            put("id", runId)
            put("flow_id", flowId)
            put("status", "running")
            put("started_at", System.currentTimeMillis())
        })
    }

    fun updateRun(runId: String, status: String, state: String?, error: String?) {
        writableDatabase.update("runs", ContentValues().apply {
            put("status", status)
            put("state", state)
            put("error", error)
            put("finished_at", System.currentTimeMillis())
        }, "id = ?", arrayOf(runId))
    }

    fun appendEvent(runId: String, seq: Int, json: String) {
        writableDatabase.insertWithOnConflict(
            "run_events",
            null,
            ContentValues().apply {
                put("run_id", runId)
                put("seq", seq)
                put("json", json)
            },
            SQLiteDatabase.CONFLICT_IGNORE,
        )
    }
}
