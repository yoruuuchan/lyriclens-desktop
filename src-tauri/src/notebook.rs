// NotebookEntry storage backed by SQLite (single connection, owned by
// the Tauri app state). Schema follows
// `LyricLens/docs/schema/notebook-entry.md` v1 exactly — any field
// change here needs the matching change in the plugin's IndexedDB
// store and a JSON schema version bump.
//
// Why SQLite + rusqlite (not tauri-plugin-sql): the schema doc requires
// strict field validation (uuid v4, starredAt <= updatedAt, source
// enum), and validation in Rust commands means the JS layer can't
// bypass it. The plugin's strength is letting JS run raw SQL, which is
// exactly the surface we don't want exposed.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;

#[derive(Debug, Error)]
pub enum NotebookError {
    #[error("invalid entry: {0}")]
    Validation(String),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPoint {
    // schema's "type" field; `kind` here to avoid the keyword clash.
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisCard {
    pub index: i64,
    pub line_index: i64,
    pub original: String,
    pub translation: String,
    pub points: Vec<AnalysisPoint>,
    pub note: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntrySource {
    Plugin,
    Desktop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookEntry {
    pub id: String,
    pub song_key: String,
    pub song_title: String,
    pub song_artist: String,
    pub line_index: i64,
    pub line_text: String,
    pub card: AnalysisCard,
    pub user_note: String,
    pub starred_at: i64,
    pub updated_at: i64,
    pub source: EntrySource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_merged_from: Option<Vec<String>>,
}

pub type DbHandle = Mutex<Connection>;

pub fn open_db(path: &Path) -> Result<Connection, NotebookError> {
    let conn = Connection::open(path)?;
    // WAL avoids reader/writer blocking on the single writer the app
    // will ever have; foreign_keys is on by reflex even though v1
    // schema has none.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), NotebookError> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS notebook_entries (
            id TEXT PRIMARY KEY,
            song_key TEXT NOT NULL,
            song_title TEXT NOT NULL,
            song_artist TEXT NOT NULL,
            line_index INTEGER NOT NULL,
            line_text TEXT NOT NULL,
            card_json TEXT NOT NULL,
            user_note TEXT NOT NULL DEFAULT '',
            starred_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            source TEXT NOT NULL,
            import_merged_from_json TEXT,
            UNIQUE(song_key, line_index)
        );

        CREATE INDEX IF NOT EXISTS idx_notebook_song_key
            ON notebook_entries(song_key);
        CREATE INDEX IF NOT EXISTS idx_notebook_starred_at
            ON notebook_entries(starred_at);
        "#,
    )?;
    Ok(())
}

fn validate(entry: &NotebookEntry) -> Result<(), NotebookError> {
    // Mirrors the §"字段约束" table in the schema doc. Failures here are
    // structural — the UI shouldn't have produced them — but enforcing
    // in Rust means an import path can't smuggle bad rows in either.
    if uuid::Uuid::parse_str(&entry.id).is_err() {
        return Err(NotebookError::Validation(format!(
            "id is not a valid uuid: {:?}",
            entry.id
        )));
    }
    if entry.song_key.trim().is_empty() {
        return Err(NotebookError::Validation("songKey is empty".into()));
    }
    if entry.song_title.trim().is_empty() {
        return Err(NotebookError::Validation("songTitle is empty".into()));
    }
    if entry.song_artist.trim().is_empty() {
        return Err(NotebookError::Validation("songArtist is empty".into()));
    }
    if entry.line_index < 0 {
        return Err(NotebookError::Validation(format!(
            "lineIndex must be >= 0, got {}",
            entry.line_index
        )));
    }
    if entry.line_text.trim().is_empty() {
        return Err(NotebookError::Validation("lineText is empty".into()));
    }
    if entry.starred_at > entry.updated_at {
        return Err(NotebookError::Validation(format!(
            "starredAt ({}) must be <= updatedAt ({})",
            entry.starred_at, entry.updated_at
        )));
    }
    if let Some(merged) = &entry.import_merged_from {
        for id in merged {
            if uuid::Uuid::parse_str(id).is_err() {
                return Err(NotebookError::Validation(format!(
                    "importMergedFrom contains invalid uuid: {id:?}"
                )));
            }
        }
    }
    Ok(())
}

pub fn upsert(conn: &Connection, entry: &NotebookEntry) -> Result<NotebookEntry, NotebookError> {
    validate(entry)?;
    let card_json = serde_json::to_string(&entry.card)?;
    let merged_json = entry
        .import_merged_from
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let source_str = match entry.source {
        EntrySource::Plugin => "plugin",
        EntrySource::Desktop => "desktop",
    };

    // ON CONFLICT on (song_key, line_index): preserve the existing id,
    // starred_at, and source. The user's first star wins for those
    // ledger-style fields; everything else (text, card, user_note,
    // updated_at) reflects the latest upsert. This matches the
    // "再 star 同一行 = 更新卡片快照" use case without the import path's
    // merge rules (those live in a separate import command, later PR).
    conn.execute(
        r#"
        INSERT INTO notebook_entries (
            id, song_key, song_title, song_artist,
            line_index, line_text, card_json, user_note,
            starred_at, updated_at, source, import_merged_from_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(song_key, line_index) DO UPDATE SET
            song_title = excluded.song_title,
            song_artist = excluded.song_artist,
            line_text = excluded.line_text,
            card_json = excluded.card_json,
            user_note = excluded.user_note,
            updated_at = excluded.updated_at,
            import_merged_from_json = excluded.import_merged_from_json
        "#,
        params![
            entry.id,
            entry.song_key,
            entry.song_title,
            entry.song_artist,
            entry.line_index,
            entry.line_text,
            card_json,
            entry.user_note,
            entry.starred_at,
            entry.updated_at,
            source_str,
            merged_json,
        ],
    )?;

    // Return the *stored* row so the caller knows the real id / starred_at
    // (which may differ from the input when ON CONFLICT fired).
    let stored = get_by_business_key(conn, &entry.song_key, entry.line_index)?
        .expect("upserted row must exist");
    Ok(stored)
}

pub fn list(conn: &Connection) -> Result<Vec<NotebookEntry>, NotebookError> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, song_key, song_title, song_artist, line_index, line_text,
               card_json, user_note, starred_at, updated_at, source,
               import_merged_from_json
        FROM notebook_entries
        ORDER BY starred_at DESC
        "#,
    )?;
    let rows = stmt.query_map([], row_to_entry)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row??);
    }
    Ok(out)
}

pub fn remove(conn: &Connection, id: &str) -> Result<bool, NotebookError> {
    let affected = conn.execute(
        "DELETE FROM notebook_entries WHERE id = ?1",
        params![id],
    )?;
    Ok(affected > 0)
}

fn get_by_business_key(
    conn: &Connection,
    song_key: &str,
    line_index: i64,
) -> Result<Option<NotebookEntry>, NotebookError> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, song_key, song_title, song_artist, line_index, line_text,
               card_json, user_note, starred_at, updated_at, source,
               import_merged_from_json
        FROM notebook_entries
        WHERE song_key = ?1 AND line_index = ?2
        "#,
    )?;
    let row = stmt
        .query_row(params![song_key, line_index], row_to_entry)
        .optional()?;
    row.transpose().map_err(Into::into)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<NotebookEntry, NotebookError>> {
    // Two-layer Result: rusqlite's row-extraction errors stay in the
    // outer Result, but JSON-deserialize failures inside one row need
    // their own channel. Callers `??` to flatten.
    let card_json: String = row.get(6)?;
    let merged_json: Option<String> = row.get(11)?;
    let source_str: String = row.get(10)?;

    let card = match serde_json::from_str::<AnalysisCard>(&card_json) {
        Ok(c) => c,
        Err(e) => return Ok(Err(NotebookError::Json(e))),
    };
    let import_merged_from = match merged_json {
        Some(s) => match serde_json::from_str::<Vec<String>>(&s) {
            Ok(v) => Some(v),
            Err(e) => return Ok(Err(NotebookError::Json(e))),
        },
        None => None,
    };
    let source = match source_str.as_str() {
        "plugin" => EntrySource::Plugin,
        "desktop" => EntrySource::Desktop,
        other => {
            return Ok(Err(NotebookError::Validation(format!(
                "unknown source value: {other:?}"
            ))));
        }
    };

    Ok(Ok(NotebookEntry {
        id: row.get(0)?,
        song_key: row.get(1)?,
        song_title: row.get(2)?,
        song_artist: row.get(3)?,
        line_index: row.get(4)?,
        line_text: row.get(5)?,
        card,
        user_note: row.get(7)?,
        starred_at: row.get(8)?,
        updated_at: row.get(9)?,
        source,
        import_merged_from,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn sample_entry(id: &str, song_key: &str, line_index: i64) -> NotebookEntry {
        NotebookEntry {
            id: id.into(),
            song_key: song_key.into(),
            song_title: "Brave Shine".into(),
            song_artist: "Aimer".into(),
            line_index,
            line_text: "強く眩しい光が".into(),
            card: AnalysisCard {
                index: line_index,
                line_index,
                original: "強く眩しい光が".into(),
                translation: "强烈而耀眼的光".into(),
                points: vec![AnalysisPoint {
                    kind: "vocabulary".into(),
                    text: "眩しい: 耀眼的".into(),
                }],
                note: "".into(),
                start_ms: Some(12_000),
                end_ms: Some(15_500),
            },
            user_note: "first star".into(),
            starred_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            source: EntrySource::Desktop,
            import_merged_from: None,
        }
    }

    #[test]
    fn upsert_insert_then_list() {
        let conn = fresh_db();
        let entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "brave shine|aimer|234",
            7,
        );
        let stored = upsert(&conn, &entry).unwrap();
        assert_eq!(stored.id, entry.id);
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].line_text, "強く眩しい光が");
    }

    #[test]
    fn upsert_conflict_preserves_id_and_starred_at() {
        let conn = fresh_db();
        let original = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            3,
        );
        upsert(&conn, &original).unwrap();

        let mut updated = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song|artist|200",
            3,
        );
        updated.user_note = "edited".into();
        updated.starred_at = 1_800_000_000_000;
        updated.updated_at = 1_800_000_000_000;

        let stored = upsert(&conn, &updated).unwrap();
        assert_eq!(stored.id, original.id, "id must be preserved on conflict");
        assert_eq!(
            stored.starred_at, original.starred_at,
            "starred_at must be preserved on conflict"
        );
        assert_eq!(stored.user_note, "edited");
        assert_eq!(stored.updated_at, 1_800_000_000_000);
    }

    #[test]
    fn remove_deletes_row() {
        let conn = fresh_db();
        let entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        upsert(&conn, &entry).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
        let removed = remove(&conn, &entry.id).unwrap();
        assert!(removed);
        assert_eq!(list(&conn).unwrap().len(), 0);
        assert!(!remove(&conn, &entry.id).unwrap());
    }

    #[test]
    fn validation_rejects_bad_uuid() {
        let conn = fresh_db();
        let mut entry = sample_entry("not-a-uuid", "song|artist|200", 0);
        entry.id = "not-a-uuid".into();
        let err = upsert(&conn, &entry).unwrap_err();
        assert!(matches!(err, NotebookError::Validation(_)));
    }

    #[test]
    fn validation_rejects_starred_after_updated() {
        let conn = fresh_db();
        let mut entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        entry.starred_at = 2_000;
        entry.updated_at = 1_000;
        let err = upsert(&conn, &entry).unwrap_err();
        assert!(matches!(err, NotebookError::Validation(_)));
    }
}
