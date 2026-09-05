//! The Tauri shell.
//!
//! Deliberately thin. All CRDT logic lives in TypeScript so that the exact
//! same code runs in the desktop app, in a browser tab, and in the test suite
//! — a second implementation in Rust would be a second thing to keep
//! convergent, and convergence bugs between two implementations of the same
//! merge rules are the worst kind to debug.
//!
//! Rust's job here is the part a webview cannot do: a real SQLite file on
//! disk, in the platform's application-data directory, with durable appends.
//!
//! The commands are deliberately dumb. They store and return opaque JSON
//! strings and never parse an operation, for the same reason the relay does
//! not: any process that understands the data model is a process that can
//! disagree with the others about it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{Manager, State};

struct Db(Mutex<Connection>);

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS ops (
             key     TEXT PRIMARY KEY,
             replica TEXT NOT NULL,
             seq     INTEGER NOT NULL,
             lamport INTEGER NOT NULL,
             body    TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS ops_by_replica ON ops(replica, seq);
         CREATE INDEX IF NOT EXISTS ops_by_lamport ON ops(lamport);",
    )
}

/// Every stored operation, in Lamport order.
///
/// Replay is order-independent by design, but handing them back in causal
/// order means the log applies in one pass instead of cycling through its
/// pending buffer.
#[tauri::command]
fn load_ops(db: State<Db>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT body FROM ops ORDER BY lamport, replica, seq")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Append a batch of operations.
///
/// `INSERT OR IGNORE` on the operation id makes this idempotent at the storage
/// layer too, so a retry after an interrupted write cannot duplicate anything.
/// One transaction per batch: a keystroke run is one fsync, not one per
/// character.
#[tauri::command]
fn append_ops(db: State<Db>, ops: Vec<OpRow>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut written = 0usize;
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO ops(key, replica, seq, lamport, body) VALUES (?1, ?2, ?3, ?4, ?5)")
            .map_err(|e| e.to_string())?;
        for op in &ops {
            written += stmt
                .execute(rusqlite::params![op.key, op.replica, op.seq, op.lamport, op.body])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(written)
}

#[derive(serde::Deserialize)]
struct OpRow {
    key: String,
    replica: String,
    seq: i64,
    lamport: i64,
    body: String,
}

#[tauri::command]
fn read_meta(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
}

#[tauri::command]
fn write_meta(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Platform application-data directory: ~/.local/share on Linux,
            // ~/Library/Application Support on macOS, %APPDATA% on Windows.
            let dir = app
                .path_resolver()
                .app_data_dir()
                .expect("no application data directory");
            std::fs::create_dir_all(&dir)?;
            let conn = Connection::open(dir.join("tether.db"))?;
            init_schema(&conn)?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![load_ops, append_ops, read_meta, write_meta])
        .run(tauri::generate_context!())
        .expect("failed to start tether");
}
