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
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
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

// JSON export — schema doc §"JSON 导出 / 导入格式" locks the top-level
// shape. The payload is what the Android reviewer app will eat as its
// MVP corpus, so the schema string is load-bearing: a reader that sees
// anything other than "lyriclens.notebook.v1" is supposed to refuse,
// not best-effort parse. `entries` order follows list()'s starred_at
// DESC, but the schema explicitly says order isn't guaranteed.
pub fn build_export_payload(
    conn: &Connection,
) -> Result<(serde_json::Value, usize), NotebookError> {
    let entries = list(conn)?;
    let count = entries.len();
    let payload = serde_json::json!({
        "schema": "lyriclens.notebook.v1",
        "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "exportedFrom": "desktop",
        "entries": entries,
    });
    Ok((payload, count))
}

pub fn export_to_path(conn: &Connection, path: &Path) -> Result<usize, NotebookError> {
    let (payload, count) = build_export_payload(conn)?;
    // Pretty-print so a human (Yoru) opening the file in VS Code sees
    // something legible — readers (Android app, future import command)
    // don't care about whitespace.
    let serialized = serde_json::to_string_pretty(&payload)?;
    std::fs::write(path, serialized)?;
    Ok(count)
}

// Anki TSV export — schema doc §"Anki CSV 导出" locks the layout:
// Front\tBack\tTags, one row per entry. Field-internal \n becomes <br>
// (Anki renders HTML) and \t becomes a single space so it can't break
// the column count. Tags drop whitespace and the songKey delimiter `|`
// to underscores, since Anki splits tags on whitespace.

const POINT_LABELS: &[(&str, &str)] = &[
    ("vocabulary", "词汇"),
    ("grammar", "语法"),
    ("culture", "文化背景"),
    ("pronunciation", "发音"),
    ("tone", "语感"),
    ("general", "补充"),
];

fn label_of(kind: &str) -> &'static str {
    POINT_LABELS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, label)| *label)
        .unwrap_or("其他")
}

fn sanitize_anki_field(s: &str) -> String {
    s.replace('\t', " ").replace('\n', "<br>")
}

fn sanitize_tag_song_key(song_key: &str) -> String {
    // Anki splits tags on whitespace and treats `|` specially in
    // search; replacing both with `_` keeps the tag a single token
    // that still echoes the original key for human searching.
    song_key.replace(['|', ' '], "_")
}

fn anki_row_for(entry: &NotebookEntry) -> String {
    let front = format!(
        "{} — {}\n{}",
        entry.song_title.trim(),
        entry.song_artist.trim(),
        entry.line_text.trim(),
    );

    // Each section is one paragraph; sections are joined by a blank
    // line (\n\n). Empty sections drop out so the Back never carries a
    // stray "---" or trailing blank.
    let mut sections: Vec<String> = Vec::new();
    let translation = entry.card.translation.trim();
    if !translation.is_empty() {
        sections.push(translation.to_string());
    }
    if !entry.card.points.is_empty() {
        let points_block = entry
            .card
            .points
            .iter()
            .map(|p| format!("{}: {}", label_of(&p.kind), p.text.trim()))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(points_block);
    }
    let card_note = entry.card.note.trim();
    if !card_note.is_empty() {
        sections.push(card_note.to_string());
    }
    let user_note = entry.user_note.trim();
    if !user_note.is_empty() {
        // "---" on its own line keeps the user's note visually separated
        // from the LLM-generated material above it.
        sections.push(format!("---\n{user_note}"));
    }
    let back = sections.join("\n\n");

    let source_str = match entry.source {
        EntrySource::Plugin => "plugin",
        EntrySource::Desktop => "desktop",
    };
    let tags = format!(
        "lyriclens song:{} source:{}",
        sanitize_tag_song_key(&entry.song_key),
        source_str,
    );

    format!(
        "{}\t{}\t{}",
        sanitize_anki_field(&front),
        sanitize_anki_field(&back),
        tags,
    )
}

pub fn build_anki_tsv(conn: &Connection) -> Result<(String, usize), NotebookError> {
    let entries = list(conn)?;
    let count = entries.len();
    let mut tsv = String::new();
    for entry in &entries {
        tsv.push_str(&anki_row_for(entry));
        tsv.push('\n');
    }
    Ok((tsv, count))
}

pub fn export_anki_to_path(conn: &Connection, path: &Path) -> Result<usize, NotebookError> {
    let (tsv, count) = build_anki_tsv(conn)?;
    std::fs::write(path, tsv)?;
    Ok(count)
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

    #[test]
    fn export_payload_has_schema_envelope_and_all_entries() {
        let conn = fresh_db();
        upsert(
            &conn,
            &sample_entry(
                "11111111-1111-4111-8111-111111111111",
                "song-a|artist|200",
                0,
            ),
        )
        .unwrap();
        upsert(
            &conn,
            &sample_entry(
                "22222222-2222-4222-8222-222222222222",
                "song-b|artist|200",
                1,
            ),
        )
        .unwrap();
        upsert(
            &conn,
            &sample_entry(
                "33333333-3333-4333-8333-333333333333",
                "song-c|artist|200",
                2,
            ),
        )
        .unwrap();

        let (payload, count) = build_export_payload(&conn).unwrap();
        assert_eq!(count, 3);
        assert_eq!(payload["schema"], "lyriclens.notebook.v1");
        assert_eq!(payload["exportedFrom"], "desktop");
        let exported_at = payload["exportedAt"].as_str().expect("exportedAt is string");
        assert!(
            chrono::DateTime::parse_from_rfc3339(exported_at).is_ok(),
            "exportedAt should be RFC3339, got {exported_at:?}",
        );
        let entries = payload["entries"].as_array().expect("entries is array");
        assert_eq!(entries.len(), 3);
        // Round-trip the first entry back through NotebookEntry to make
        // sure the camelCase serialization isn't lossy.
        let back: NotebookEntry =
            serde_json::from_value(entries[0].clone()).expect("entry round-trip");
        assert!(!back.song_title.is_empty());
        assert!(!back.song_key.is_empty());
    }

    #[test]
    fn export_preserves_special_chars_in_user_note() {
        // The Android consumer treats userNote as opaque user text — if
        // serde_json mangles `\n` / `"` / `\t` here, the round-trip on
        // the other side breaks silently and we'd never know until users
        // complained. Lock the behaviour with a test.
        let conn = fresh_db();
        let mut entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        entry.user_note = "line1\n\"quoted\"\ttab後の文字".into();
        upsert(&conn, &entry).unwrap();

        let (payload, _) = build_export_payload(&conn).unwrap();
        let entries = payload["entries"].as_array().unwrap();
        let back: NotebookEntry = serde_json::from_value(entries[0].clone()).unwrap();
        assert_eq!(back.user_note, "line1\n\"quoted\"\ttab後の文字");
    }

    #[test]
    fn anki_row_has_three_tab_columns_and_expected_front() {
        let conn = fresh_db();
        let entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "brave shine|aimer|234",
            7,
        );
        upsert(&conn, &entry).unwrap();

        let (tsv, count) = build_anki_tsv(&conn).unwrap();
        assert_eq!(count, 1);
        // Trailing newline → split lossless across rows.
        let lines: Vec<&str> = tsv.trim_end_matches('\n').split('\n').collect();
        assert_eq!(lines.len(), 1);

        let cols: Vec<&str> = lines[0].split('\t').collect();
        assert_eq!(cols.len(), 3, "Front\\tBack\\tTags");
        assert_eq!(
            cols[0], "Brave Shine — Aimer<br>強く眩しい光が",
            "Front carries title — artist<br>lineText after \\n→<br> rewrite",
        );
        assert!(
            cols[1].starts_with("强烈而耀眼的光<br><br>词汇: 眩しい: 耀眼的"),
            "Back leads with translation, then blank line, then label-prefixed point: {}",
            cols[1],
        );
        assert!(
            cols[1].ends_with("<br><br>---<br>first star"),
            "Back ends with the user note section after the --- divider: {}",
            cols[1],
        );
        assert_eq!(
            cols[2], "lyriclens song:brave_shine_aimer_234 source:desktop",
            "Tags column: songKey | and spaces folded to _, source intact",
        );
    }

    #[test]
    fn anki_label_falls_back_for_unknown_point_kinds() {
        // Unknown point kind shouldn't blow up the export — we want a
        // best-effort label so a future v2 schema with new kinds still
        // produces usable CSV from a v1-trained client.
        assert_eq!(label_of("vocabulary"), "词汇");
        assert_eq!(label_of("grammar"), "语法");
        assert_eq!(label_of("culture"), "文化背景");
        assert_eq!(label_of("pronunciation"), "发音");
        assert_eq!(label_of("tone"), "语感");
        assert_eq!(label_of("general"), "补充");
        assert_eq!(label_of("nonsense"), "其他");
    }

    #[test]
    fn anki_row_sanitizes_tabs_and_newlines_in_fields() {
        let conn = fresh_db();
        let mut entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        // A userNote with a real \t and \n must not break the column
        // count or row count.
        entry.user_note = "tab\there\nnew line".into();
        upsert(&conn, &entry).unwrap();

        let (tsv, _) = build_anki_tsv(&conn).unwrap();
        let rows: Vec<&str> = tsv.trim_end_matches('\n').split('\n').collect();
        assert_eq!(rows.len(), 1, "internal \\n must not split rows");
        let cols: Vec<&str> = rows[0].split('\t').collect();
        assert_eq!(cols.len(), 3, "internal \\t must not split columns");
        assert!(cols[1].contains("tab here"), "tab → space in field");
        assert!(
            cols[1].contains("here<br>new line"),
            "newline → <br> in field, but the literal 'new line' space stays: {}",
            cols[1],
        );
    }

    #[test]
    fn anki_back_omits_empty_sections_cleanly() {
        // No points, no card.note, no userNote — Back should be the
        // translation only with no stray blank lines or `---`.
        let conn = fresh_db();
        let mut entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        entry.card.points.clear();
        entry.card.note = "".into();
        entry.user_note = "".into();
        upsert(&conn, &entry).unwrap();

        let (tsv, _) = build_anki_tsv(&conn).unwrap();
        let cols: Vec<&str> = tsv.trim_end_matches('\n').split('\t').collect();
        assert_eq!(cols[1], "强烈而耀眼的光");
        assert!(
            !cols[1].contains("---"),
            "no divider when userNote is empty"
        );
    }

    #[test]
    fn export_to_path_writes_parseable_file() {
        let conn = fresh_db();
        upsert(
            &conn,
            &sample_entry(
                "11111111-1111-4111-8111-111111111111",
                "song-a|artist|200",
                0,
            ),
        )
        .unwrap();

        // tempfile is one more dep we don't otherwise need; cobble a
        // unique name out of pid + nanos and clean up at the end.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir()
            .join(format!("lyriclens-test-export-{}-{}.json", std::process::id(), nanos));

        let count = export_to_path(&conn, &path).unwrap();
        assert_eq!(count, 1);

        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["schema"], "lyriclens.notebook.v1");
        assert_eq!(parsed["entries"].as_array().unwrap().len(), 1);

        let _ = std::fs::remove_file(&path);
    }
}
