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
    // Optional surface / reading for JLPT (and future CEFR-J) badge
    // lookup on vocabulary/grammar points. Skip when serializing so old
    // notebook entries whose card snapshot predates this field don't
    // get littered with `"surface": null` on export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
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

impl EntrySource {
    pub fn as_str(self) -> &'static str {
        match self {
            EntrySource::Plugin => "plugin",
            EntrySource::Desktop => "desktop",
        }
    }
}

// v1.1 mastery: 只作为「进度日记」记安卓 review 页给出的评价，绝不
// 参与抽卡算法（严格贴合 roadmap 上「不做 SRS」承诺）。四档 + 隐式
// `New` 对应星标但从未 review 的默认状态。桌面 + 插件端 read-only，
// 无评价按钮 —— Yes/Meh/No 只可能通过 import 从安卓 app 流回。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MasteryLevel {
    Yes,
    Meh,
    No,
    #[default]
    New,
}

impl MasteryLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            MasteryLevel::Yes => "yes",
            MasteryLevel::Meh => "meh",
            MasteryLevel::No => "no",
            MasteryLevel::New => "new",
        }
    }

    fn from_str(raw: &str) -> Option<Self> {
        match raw {
            "yes" => Some(MasteryLevel::Yes),
            "meh" => Some(MasteryLevel::Meh),
            "no" => Some(MasteryLevel::No),
            "new" => Some(MasteryLevel::New),
            _ => None,
        }
    }
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
    // v1.1 additive fields; pre-v1.1 exports omit both so `serde(default)`
    // materializes MasteryLevel::New + None which matches the "never
    // reviewed" contract. Top-level envelope schema string stays at
    // "lyriclens.notebook.v1" — additive extensions don't bump it per
    // the schema doc's own versioning policy.
    #[serde(default)]
    pub mastery: MasteryLevel,
    #[serde(default)]
    pub last_reviewed_at: Option<i64>,
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
    // Fresh installs get the columns from CREATE TABLE. Upgrades from a
    // v1 DB (no mastery / last_reviewed_at) fall through to the ALTER
    // block below, which is idempotent — table_info walks the current
    // columns and only ADDs the ones missing.
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
            mastery TEXT NOT NULL DEFAULT 'new',
            last_reviewed_at INTEGER,
            UNIQUE(song_key, line_index)
        );

        CREATE INDEX IF NOT EXISTS idx_notebook_song_key
            ON notebook_entries(song_key);
        CREATE INDEX IF NOT EXISTS idx_notebook_starred_at
            ON notebook_entries(starred_at);
        "#,
    )?;

    // SQLite doesn't support ADD COLUMN IF NOT EXISTS. Query the current
    // columns via PRAGMA table_info, then ADD only the ones missing so
    // existing v1 databases upgrade in place on the next app launch. Old
    // rows get mastery='new' (NOT NULL DEFAULT) and last_reviewed_at=NULL,
    // which is exactly the "never reviewed" state.
    let mut existing: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stmt = conn.prepare("PRAGMA table_info(notebook_entries)")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        existing.insert(name);
    }
    drop(rows);
    drop(stmt);

    if !existing.contains("mastery") {
        conn.execute(
            "ALTER TABLE notebook_entries ADD COLUMN mastery TEXT NOT NULL DEFAULT 'new'",
            [],
        )?;
    }
    if !existing.contains("last_reviewed_at") {
        conn.execute(
            "ALTER TABLE notebook_entries ADD COLUMN last_reviewed_at INTEGER",
            [],
        )?;
    }

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
    // mastery is enum-validated by serde on the way in; nothing more to
    // check here. lastReviewedAt must be a positive timestamp if set —
    // 0/negative would fail the "must be > 0" schema doc constraint and
    // suggests the caller passed an uninitialized default int.
    if let Some(ts) = entry.last_reviewed_at {
        if ts <= 0 {
            return Err(NotebookError::Validation(format!(
                "lastReviewedAt must be > 0 when set, got {ts}"
            )));
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
    let source_str = entry.source.as_str();

    // ON CONFLICT on (song_key, line_index): preserve the existing id,
    // starred_at, source, AND mastery/last_reviewed_at. Re-starring a
    // line refreshes the card snapshot but must not blow away the
    // Android side's review progress — those two columns are excluded
    // from the DO UPDATE clause deliberately. The `import` path uses
    // `replace_full` instead when it needs to overwrite these.
    conn.execute(
        r#"
        INSERT INTO notebook_entries (
            id, song_key, song_title, song_artist,
            line_index, line_text, card_json, user_note,
            starred_at, updated_at, source, import_merged_from_json,
            mastery, last_reviewed_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
            entry.mastery.as_str(),
            entry.last_reviewed_at,
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
               import_merged_from_json, mastery, last_reviewed_at
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

// JSON import — schema doc §"合并规则". `upsert()` above intentionally
// preserves local starred_at and overwrites user_note (the user re-star
// flow), which is the wrong semantics for import. So import has its own
// low-level write path (`replace_full`) that takes a fully-merged entry
// and writes every column verbatim, plus a `merge_into` helper that
// follows the schema's seven-step merge spec.

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub total_parsed: usize,
    pub imported: usize,
    pub merged: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    Merged,
    SkippedDuplicate,
}

pub fn merge_into(
    local: &NotebookEntry,
    incoming: &NotebookEntry,
    import_ts_ms: i64,
    import_iso: &str,
) -> (NotebookEntry, MergeOutcome) {
    let incoming_source = incoming.source.as_str();
    let marker_head = format!("---来自 {incoming_source}（");

    // Schema's "跳过这条" trigger: same source marker is already in
    // local AND the incoming.userNote text is already present verbatim.
    // The double-check guards against a false positive when the user
    // manually wrote a "---来自" line themselves.
    if !incoming.user_note.is_empty()
        && local.user_note.contains(&marker_head)
        && local.user_note.contains(&incoming.user_note)
    {
        return (local.clone(), MergeOutcome::SkippedDuplicate);
    }

    let mut merged = local.clone();
    // 1. id 保留为 local
    // 2. userNote 拼接（incoming 空 → 不动 local）
    if !incoming.user_note.is_empty() {
        let separator =
            format!("\n\n---来自 {incoming_source}（{import_iso}）---\n");
        merged.user_note = format!(
            "{}{}{}",
            local.user_note, separator, incoming.user_note,
        );
    }
    // 3. card 用 updatedAt 更晚的（防 prompt 回退）
    if incoming.updated_at > local.updated_at {
        merged.card = incoming.card.clone();
    }
    // 4. starredAt 用更早的（保留最早收藏时间语义）
    merged.starred_at = local.starred_at.min(incoming.starred_at);
    // 5. updatedAt = 本次 import 时间
    merged.updated_at = import_ts_ms;
    // 6. importMergedFrom 追加 incoming.id，去重防 A→B→A 死循环
    let mut from = local.import_merged_from.clone().unwrap_or_default();
    if !from.contains(&incoming.id) {
        from.push(incoming.id.clone());
    }
    merged.import_merged_from = Some(from);
    // 7. source 不变（合并后仍属于本地 host）
    // 8. v1.1 mastery: 取 lastReviewedAt 更晚的一份；两边都 null 时不
    //    覆盖（保持 local.mastery = New + null）。mastery 的权威时间戳
    //    是独立的 last_reviewed_at，跟 starred_at / updated_at 无关。
    match (local.last_reviewed_at, incoming.last_reviewed_at) {
        (None, None) => {} // 双 null：保持 local
        (Some(_), None) => {} // 只 local 有：保持 local
        (None, Some(_)) => {
            merged.mastery = incoming.mastery;
            merged.last_reviewed_at = incoming.last_reviewed_at;
        }
        (Some(l), Some(i)) => {
            if i > l {
                merged.mastery = incoming.mastery;
                merged.last_reviewed_at = incoming.last_reviewed_at;
            }
        }
    }

    (merged, MergeOutcome::Merged)
}

// Writes every column verbatim — no ON CONFLICT preservation. Used by
// import after `merge_into` produces a fully-resolved row. Must run
// inside an existing transaction because import wraps the whole batch.
fn replace_full(conn: &Connection, entry: &NotebookEntry) -> Result<(), NotebookError> {
    validate(entry)?;
    let card_json = serde_json::to_string(&entry.card)?;
    let merged_json = entry
        .import_merged_from
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    conn.execute(
        r#"
        INSERT OR REPLACE INTO notebook_entries (
            id, song_key, song_title, song_artist,
            line_index, line_text, card_json, user_note,
            starred_at, updated_at, source, import_merged_from_json,
            mastery, last_reviewed_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
            entry.source.as_str(),
            merged_json,
            entry.mastery.as_str(),
            entry.last_reviewed_at,
        ],
    )?;
    Ok(())
}

// Top-level envelope mirror of build_export_payload's output. Used
// only for parsing; the entries themselves go through NotebookEntry.
#[derive(Debug, Deserialize)]
struct ImportEnvelope {
    schema: String,
    entries: Vec<NotebookEntry>,
}

pub fn import_from_json_str(
    conn: &mut Connection,
    raw: &str,
    import_ts_ms: i64,
) -> Result<ImportSummary, NotebookError> {
    let envelope: ImportEnvelope = serde_json::from_str(raw)?;
    if envelope.schema != "lyriclens.notebook.v1" {
        return Err(NotebookError::Validation(format!(
            "unknown schema version: {:?} (expected lyriclens.notebook.v1)",
            envelope.schema,
        )));
    }

    let import_iso = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(import_ts_ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let mut summary = ImportSummary {
        total_parsed: envelope.entries.len(),
        ..ImportSummary::default()
    };

    // One transaction around the whole batch — partial failures inside
    // the loop (validation, merge-skip) are counted in the summary and
    // don't abort the rest, but a SQL-level error rolls everything back.
    let tx = conn.transaction()?;
    for incoming in &envelope.entries {
        if let Err(err) = validate(incoming) {
            summary.skipped += 1;
            summary.errors.push(err.to_string());
            continue;
        }

        let local =
            get_by_business_key(&tx, &incoming.song_key, incoming.line_index)?;
        match local {
            None => {
                if let Err(err) = replace_full(&tx, incoming) {
                    summary.skipped += 1;
                    summary.errors.push(err.to_string());
                } else {
                    summary.imported += 1;
                }
            }
            Some(local_entry) => {
                let (merged, outcome) =
                    merge_into(&local_entry, incoming, import_ts_ms, &import_iso);
                match outcome {
                    MergeOutcome::SkippedDuplicate => {
                        summary.skipped += 1;
                    }
                    MergeOutcome::Merged => {
                        if let Err(err) = replace_full(&tx, &merged) {
                            summary.skipped += 1;
                            summary.errors.push(err.to_string());
                        } else {
                            summary.merged += 1;
                        }
                    }
                }
            }
        }
    }
    tx.commit()?;

    Ok(summary)
}

pub fn import_from_path(
    conn: &mut Connection,
    path: &Path,
    import_ts_ms: i64,
) -> Result<ImportSummary, NotebookError> {
    let raw = std::fs::read_to_string(path)?;
    import_from_json_str(conn, &raw, import_ts_ms)
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
               import_merged_from_json, mastery, last_reviewed_at
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
    let mastery_str: String = row.get(12)?;
    let last_reviewed_at: Option<i64> = row.get(13)?;

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
    let mastery = match MasteryLevel::from_str(&mastery_str) {
        Some(m) => m,
        None => {
            return Ok(Err(NotebookError::Validation(format!(
                "unknown mastery value: {mastery_str:?}"
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
        mastery,
        last_reviewed_at,
    }))
}

#[cfg(test)]
// Test names embed schema field names verbatim (userNote, starredAt,
// updatedAt, importMergedFrom) — easier to grep against the schema doc
// than camel-to-snake conversions. The non_snake_case warning here is
// noise, so silence it module-wide.
#[allow(non_snake_case)]
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
                    surface: None,
                    reading: None,
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
            mastery: MasteryLevel::New,
            last_reviewed_at: None,
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

    // ─── import + merge tests ────────────────────────────────────

    // Build a minimal valid v1 envelope around a single sample entry.
    fn envelope_with(entries: &[NotebookEntry]) -> String {
        serde_json::json!({
            "schema": "lyriclens.notebook.v1",
            "exportedAt": "2026-07-01T00:00:00Z",
            "exportedFrom": "plugin",
            "entries": entries,
        })
        .to_string()
    }

    const IMPORT_TS: i64 = 1_900_000_000_000;
    const IMPORT_ISO: &str = "2030-03-16T12:26:40Z";

    #[test]
    fn import_inserts_new_entries_when_no_conflict() {
        let mut conn = fresh_db();
        let raw = envelope_with(&[
            sample_entry(
                "11111111-1111-4111-8111-111111111111",
                "song-a|artist|200",
                0,
            ),
            sample_entry(
                "22222222-2222-4222-8222-222222222222",
                "song-b|artist|200",
                1,
            ),
        ]);

        let summary = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap();
        assert_eq!(summary.total_parsed, 2);
        assert_eq!(summary.imported, 2);
        assert_eq!(summary.merged, 0);
        assert_eq!(summary.skipped, 0);
        assert!(summary.errors.is_empty());
        assert_eq!(list(&conn).unwrap().len(), 2);
    }

    #[test]
    fn import_merges_userNote_with_source_marker() {
        let mut conn = fresh_db();
        // Local was authored on desktop.
        let mut local = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        local.user_note = "本地的笔记".into();
        upsert(&conn, &local).unwrap();

        // Incoming is from plugin host with a different note.
        let mut incoming = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song|artist|200",
            0,
        );
        incoming.source = EntrySource::Plugin;
        incoming.user_note = "插件那边写的笔记".into();
        let raw = envelope_with(&[incoming]);

        let summary = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap();
        assert_eq!(summary.merged, 1);
        assert_eq!(summary.imported, 0);

        let stored = list(&conn).unwrap();
        assert_eq!(stored.len(), 1);
        let merged_note = &stored[0].user_note;
        assert!(merged_note.starts_with("本地的笔记"));
        assert!(merged_note.contains("---来自 plugin（"));
        assert!(merged_note.ends_with("插件那边写的笔记"));
        // id preserved from local; importMergedFrom records incoming.id.
        assert_eq!(stored[0].id, "11111111-1111-4111-8111-111111111111");
        assert_eq!(
            stored[0].import_merged_from.as_ref().unwrap(),
            &vec!["22222222-2222-4222-8222-222222222222".to_string()],
        );
    }

    #[test]
    fn import_takes_newer_card_by_updatedAt() {
        let mut conn = fresh_db();
        let mut local = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        local.updated_at = 1_700_000_000_000;
        local.card.translation = "本地旧翻译".into();
        upsert(&conn, &local).unwrap();

        let mut incoming = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song|artist|200",
            0,
        );
        incoming.updated_at = 1_800_000_000_000;
        incoming.card.translation = "导入的新翻译".into();
        incoming.user_note = "".into(); // 空 userNote 不触发拼接
        let raw = envelope_with(&[incoming]);

        let _ = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap();
        let stored = list(&conn).unwrap();
        assert_eq!(stored[0].card.translation, "导入的新翻译");
        // updatedAt 设为本次 import 时间，不是 incoming 的
        assert_eq!(stored[0].updated_at, IMPORT_TS);
    }

    #[test]
    fn import_keeps_local_card_when_local_is_newer() {
        let mut conn = fresh_db();
        let mut local = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        local.updated_at = 1_800_000_000_000;
        local.card.translation = "本地新翻译".into();
        upsert(&conn, &local).unwrap();

        let mut incoming = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song|artist|200",
            0,
        );
        incoming.updated_at = 1_700_000_000_000;
        incoming.card.translation = "导入的旧翻译".into();
        incoming.user_note = "".into();
        let raw = envelope_with(&[incoming]);

        let _ = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap();
        let stored = list(&conn).unwrap();
        assert_eq!(stored[0].card.translation, "本地新翻译");
    }

    #[test]
    fn import_takes_earlier_starredAt() {
        let mut conn = fresh_db();
        let mut local = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        local.starred_at = 1_800_000_000_000;
        local.updated_at = 1_800_000_000_000;
        upsert(&conn, &local).unwrap();

        let mut incoming = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song|artist|200",
            0,
        );
        incoming.starred_at = 1_700_000_000_000;
        incoming.updated_at = 1_700_000_000_000;
        incoming.user_note = "".into();
        let raw = envelope_with(&[incoming]);

        let _ = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap();
        let stored = list(&conn).unwrap();
        assert_eq!(
            stored[0].starred_at, 1_700_000_000_000,
            "earlier starred_at wins",
        );
    }

    #[test]
    fn import_skips_when_userNote_already_has_same_source_marker_and_content() {
        let mut conn = fresh_db();
        // Simulate a second import of the same plugin payload — first
        // import left a "---来自 plugin（..." marker and the incoming
        // note text in local.userNote, so a re-import should be a no-op.
        let mut local = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        local.user_note = "本地的笔记\n\n---来自 plugin（2026-06-15T12:00:00Z）---\n插件那边写的笔记".into();
        upsert(&conn, &local).unwrap();

        let mut incoming = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song|artist|200",
            0,
        );
        incoming.source = EntrySource::Plugin;
        incoming.user_note = "插件那边写的笔记".into();
        let raw = envelope_with(&[incoming]);

        let summary = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap();
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.merged, 0);
        // local.user_note unchanged
        let stored = list(&conn).unwrap();
        assert!(stored[0].user_note.contains("---来自 plugin（2026-06-15T12:00:00Z）---"));
        assert!(!stored[0].user_note.contains(IMPORT_ISO));
    }

    #[test]
    fn import_appends_to_importMergedFrom_without_duplicating() {
        let mut conn = fresh_db();
        let mut local = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song|artist|200",
            0,
        );
        local.import_merged_from = Some(vec!["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()]);
        upsert(&conn, &local).unwrap();

        // First incoming — different id, should append.
        let mut incoming = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song|artist|200",
            0,
        );
        incoming.source = EntrySource::Plugin;
        incoming.user_note = "first incoming".into();
        let _ = import_from_json_str(&mut conn, &envelope_with(&[incoming.clone()]), IMPORT_TS).unwrap();

        let after_first = list(&conn).unwrap();
        assert_eq!(
            after_first[0].import_merged_from.as_ref().unwrap(),
            &vec![
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                "22222222-2222-4222-8222-222222222222".to_string(),
            ],
        );

        // Second import of an entry with the SAME id — should NOT
        // duplicate the entry in importMergedFrom.
        incoming.user_note = "second incoming".into();
        let _ = import_from_json_str(&mut conn, &envelope_with(&[incoming]), IMPORT_TS + 1000).unwrap();
        let after_second = list(&conn).unwrap();
        let from = after_second[0].import_merged_from.as_ref().unwrap();
        assert_eq!(
            from.iter().filter(|s| s.as_str() == "22222222-2222-4222-8222-222222222222").count(),
            1,
            "incoming.id must appear only once",
        );
    }

    #[test]
    fn import_rejects_unknown_schema_version() {
        let mut conn = fresh_db();
        let raw = serde_json::json!({
            "schema": "lyriclens.notebook.v2",
            "exportedAt": "2026-07-01T00:00:00Z",
            "exportedFrom": "desktop",
            "entries": [],
        })
        .to_string();
        let err = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap_err();
        assert!(
            matches!(err, NotebookError::Validation(ref msg) if msg.contains("unknown schema version")),
            "got {err:?}",
        );
    }

    #[test]
    fn import_counts_validation_failures_as_skipped() {
        let mut conn = fresh_db();
        // Two entries: one valid, one with an invalid uuid → should
        // skip the bad one, still import the good one.
        let good = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song-good|artist|200",
            0,
        );
        let mut bad = sample_entry(
            "11111111-1111-4111-8111-111111111111", // valid here…
            "song-bad|artist|200",
            0,
        );
        // …but rewrite id post-build to bypass validate in sample_entry.
        // serde_json::to_value then mutate the JSON tree directly so the
        // envelope contains a structurally bad row.
        let mut v = serde_json::to_value(&bad).unwrap();
        v["id"] = serde_json::json!("not-a-uuid");
        bad = serde_json::from_value(v).unwrap();

        let raw = envelope_with(&[good, bad]);
        let summary = import_from_json_str(&mut conn, &raw, IMPORT_TS).unwrap();
        assert_eq!(summary.total_parsed, 2);
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.errors.len(), 1);
        assert!(summary.errors[0].contains("uuid"));
    }

    // ─── v1.1 mastery tests ──────────────────────────────────────

    #[test]
    fn mastery_defaults_to_new_and_null_lastReviewedAt() {
        let conn = fresh_db();
        let entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song-a|artist|200",
            0,
        );
        // sample_entry sets mastery=New + last_reviewed_at=None.
        upsert(&conn, &entry).unwrap();
        let stored = list(&conn).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].mastery, MasteryLevel::New);
        assert_eq!(stored[0].last_reviewed_at, None);
    }

    #[test]
    fn mastery_roundtrips_through_upsert_and_list() {
        let conn = fresh_db();
        let mut entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song-a|artist|200",
            0,
        );
        entry.mastery = MasteryLevel::Yes;
        entry.last_reviewed_at = Some(1_800_000_000_000);
        upsert(&conn, &entry).unwrap();
        let stored = list(&conn).unwrap();
        assert_eq!(stored[0].mastery, MasteryLevel::Yes);
        assert_eq!(stored[0].last_reviewed_at, Some(1_800_000_000_000));
    }

    #[test]
    fn upsert_conflict_preserves_mastery_and_lastReviewedAt() {
        // Re-starring a line refreshes card + user_note but must not
        // wipe the Android side's review progress.
        let conn = fresh_db();
        let mut first = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song-a|artist|200",
            0,
        );
        first.mastery = MasteryLevel::Yes;
        first.last_reviewed_at = Some(1_800_000_000_000);
        upsert(&conn, &first).unwrap();

        // Second upsert with default mastery — imitates the "user
        // re-stars the same line, still under mastery=new" flow. ON
        // CONFLICT DO UPDATE deliberately omits mastery /
        // last_reviewed_at from its excluded set.
        let mut second = sample_entry(
            "22222222-2222-4222-8222-222222222222",
            "song-a|artist|200",
            0,
        );
        second.user_note = "second star".into();
        upsert(&conn, &second).unwrap();
        let stored = list(&conn).unwrap();
        assert_eq!(stored.len(), 1);
        // Note updated…
        assert_eq!(stored[0].user_note, "second star");
        // …but mastery + last_reviewed_at preserved from first upsert.
        assert_eq!(stored[0].mastery, MasteryLevel::Yes);
        assert_eq!(stored[0].last_reviewed_at, Some(1_800_000_000_000));
    }

    #[test]
    fn migration_from_v1_schema_adds_mastery_columns() {
        // Build the v1 schema manually — no mastery, no last_reviewed_at
        // columns — then rerun ensure_schema which should ALTER TABLE
        // in place and stamp existing rows with the NOT NULL DEFAULT.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE notebook_entries (
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
            "#,
        )
        .unwrap();
        // Drop in a fake old row so we can verify DEFAULT behavior.
        conn.execute(
            r#"
            INSERT INTO notebook_entries (
                id, song_key, song_title, song_artist,
                line_index, line_text, card_json, user_note,
                starred_at, updated_at, source, import_merged_from_json
            )
            VALUES (
                '11111111-1111-4111-8111-111111111111',
                'song-a|artist|200', 'Song A', 'Artist',
                0, '歌詞', '{"index":0,"lineIndex":0,"original":"","translation":"","points":[],"note":"","startMs":null,"endMs":null}', '',
                1000, 1000, 'desktop', NULL
            )
            "#,
            [],
        )
        .unwrap();

        // Migrate.
        ensure_schema(&conn).unwrap();

        // Old row should now surface with mastery=new + last_reviewed_at=NULL.
        let stored = list(&conn).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].mastery, MasteryLevel::New);
        assert_eq!(stored[0].last_reviewed_at, None);

        // Re-running ensure_schema is idempotent — no error, no drift.
        ensure_schema(&conn).unwrap();
        let stored_again = list(&conn).unwrap();
        assert_eq!(stored_again.len(), 1);
    }

    #[test]
    fn merge_takes_incoming_mastery_when_incoming_lastReviewedAt_is_newer() {
        let local = sample_entry_with_mastery(
            "11111111-1111-4111-8111-111111111111",
            MasteryLevel::Yes,
            Some(1_800_000_000_000),
        );
        let incoming = sample_entry_with_mastery(
            "22222222-2222-4222-8222-222222222222",
            MasteryLevel::No,
            Some(1_900_000_000_000),
        );
        let (merged, outcome) =
            merge_into(&local, &incoming, IMPORT_TS, "2026-07-02T00:00:00Z");
        assert_eq!(outcome, MergeOutcome::Merged);
        assert_eq!(merged.mastery, MasteryLevel::No);
        assert_eq!(merged.last_reviewed_at, Some(1_900_000_000_000));
    }

    #[test]
    fn merge_keeps_local_mastery_when_local_lastReviewedAt_is_newer() {
        let local = sample_entry_with_mastery(
            "11111111-1111-4111-8111-111111111111",
            MasteryLevel::Yes,
            Some(1_900_000_000_000),
        );
        let incoming = sample_entry_with_mastery(
            "22222222-2222-4222-8222-222222222222",
            MasteryLevel::No,
            Some(1_800_000_000_000),
        );
        let (merged, _) = merge_into(&local, &incoming, IMPORT_TS, "2026-07-02T00:00:00Z");
        assert_eq!(merged.mastery, MasteryLevel::Yes);
        assert_eq!(merged.last_reviewed_at, Some(1_900_000_000_000));
    }

    #[test]
    fn merge_keeps_local_when_both_lastReviewedAt_are_null() {
        // Both entries never reviewed → merge must not overwrite the
        // local mastery/last_reviewed_at even though the local starts
        // as MasteryLevel::New (default).
        let local = sample_entry_with_mastery(
            "11111111-1111-4111-8111-111111111111",
            MasteryLevel::New,
            None,
        );
        let incoming = sample_entry_with_mastery(
            "22222222-2222-4222-8222-222222222222",
            MasteryLevel::New,
            None,
        );
        let (merged, _) = merge_into(&local, &incoming, IMPORT_TS, "2026-07-02T00:00:00Z");
        assert_eq!(merged.mastery, MasteryLevel::New);
        assert_eq!(merged.last_reviewed_at, None);
    }

    #[test]
    fn merge_adopts_incoming_when_only_incoming_has_lastReviewedAt() {
        // Local was never reviewed; incoming was reviewed on the
        // Android side → adopt the incoming mastery.
        let local = sample_entry_with_mastery(
            "11111111-1111-4111-8111-111111111111",
            MasteryLevel::New,
            None,
        );
        let incoming = sample_entry_with_mastery(
            "22222222-2222-4222-8222-222222222222",
            MasteryLevel::No,
            Some(1_900_000_000_000),
        );
        let (merged, _) = merge_into(&local, &incoming, IMPORT_TS, "2026-07-02T00:00:00Z");
        assert_eq!(merged.mastery, MasteryLevel::No);
        assert_eq!(merged.last_reviewed_at, Some(1_900_000_000_000));
    }

    #[test]
    fn merge_keeps_local_when_only_local_has_lastReviewedAt() {
        // Reverse of the previous case — local has been reviewed, the
        // incoming source hasn't. Local wins.
        let local = sample_entry_with_mastery(
            "11111111-1111-4111-8111-111111111111",
            MasteryLevel::Yes,
            Some(1_800_000_000_000),
        );
        let incoming = sample_entry_with_mastery(
            "22222222-2222-4222-8222-222222222222",
            MasteryLevel::New,
            None,
        );
        let (merged, _) = merge_into(&local, &incoming, IMPORT_TS, "2026-07-02T00:00:00Z");
        assert_eq!(merged.mastery, MasteryLevel::Yes);
        assert_eq!(merged.last_reviewed_at, Some(1_800_000_000_000));
    }

    #[test]
    fn validation_rejects_zero_lastReviewedAt() {
        let mut entry = sample_entry(
            "11111111-1111-4111-8111-111111111111",
            "song-a|artist|200",
            0,
        );
        entry.last_reviewed_at = Some(0);
        let err = validate(&entry).unwrap_err();
        assert!(
            matches!(err, NotebookError::Validation(ref msg) if msg.contains("lastReviewedAt")),
            "got {err:?}",
        );
    }

    // Helper for merge tests — clones sample_entry and stamps the two
    // v1.1 fields. `song_key` + `line_index` are identical between
    // local and incoming so the merge path fires, matching the
    // real-world "same lyric line, different host" case.
    fn sample_entry_with_mastery(
        id: &str,
        mastery: MasteryLevel,
        last_reviewed_at: Option<i64>,
    ) -> NotebookEntry {
        let mut entry = sample_entry(id, "song-shared|artist|200", 3);
        entry.mastery = mastery;
        entry.last_reviewed_at = last_reviewed_at;
        entry
    }
}
